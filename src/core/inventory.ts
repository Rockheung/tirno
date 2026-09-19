import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionMetadata } from './session-store.js';
import { isAlive } from './process-guard.js';
import { readActivePort } from './devtools-port.js';
import { scanProcListeners, cmdlineFromProc } from './proc-net.js';
import { httpBaseOf, isExternal, probeDevTools } from './external.js';

const exec = promisify(execFile);

/**
 * Answers "what is actually listening, and is it ours?" by observation rather
 * than by trusting `~/.tirno/sessions/*.json`.
 *
 * The ledger is a launch-time claim, not a fact. A port it records as a tirno
 * session can be held by something else entirely — OtherAgentApp, an
 * Electron app with a production DB proxy login tab, squats 9222 on this
 * machine. `isAlive(pid)` does not catch that, because pids get reused.
 * Connecting there hands CDP control of that app to tirno, and "cleaning up"
 * kills it.
 *
 * So ownership needs three independent facts to agree, and anything short of
 * that is never acted on. See docs/plan-anchor-broker.md §3 Stage 2.
 */

/**
 * `unknown` 은 다섯 번째 상태다 — **관측 자체가 안 됐다.** lsof 가 없거나 /proc 을 못 읽으면
 * 리스너 목록이 비는데, 그 빈 목록을 "아무것도 안 듣는다" 로 읽으면 살아 있는 세션이
 * foreign/ghost 가 된다 (#186). 허용 조치는 foreign 과 같다: 표시만, connect·kill 거부.
 */
/**
 * `external` 은 여섯 번째다 — **띄운 게 아니라 붙은 것**(`tirno connect`, #236). 프로세스
 * 소유권은 애초에 물을 수 없고 `/json/version` 이 답하는가만 본다. 허용 조치는 ours 와
 * 같되 kill · restart 의 프로세스 정리만 없다(원장 항목만 지운다).
 */
export type Ownership = 'ours' | 'foreign' | 'ambiguous' | 'ghost' | 'unknown' | 'external';

export interface Listener {
  pid: number;
  command: string;
  family: 'IPv4' | 'IPv6';
  /** '127.0.0.1', '*', '[::1]' — as lsof reports it */
  address: string;
  port: number;
}

export interface Observation {
  /** DevToolsActivePort value when present, else the port recorded at launch. */
  resolvedPort: number | null;
  pidAlive: boolean;
  /** every listener on resolvedPort, both address families */
  listeners: Listener[];
  /** set when the listener scan itself failed — `listeners` is then meaningless */
  listenersUnavailable?: string;
  /** `--user-data-dir` of the running process, normalized; null if unreadable */
  runningUserDataDir: string | null;
  /** the session's own user-data-dir, normalized the same way */
  expectedUserDataDir: string;
  pid: number;
}

export interface Verdict {
  ownership: Ownership;
  /** one line naming what was observed — goes straight into errors and `tirno ls` */
  reason: string;
}

// ---------------------------------------------------------------- parsing

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcnt`.
 *
 * The field-per-line (-F) form is not optional: the human table truncates
 * COMMAND to 9 characters and command names contain spaces ("Google Chrome",
 * "Okta Verify"), so column splitting mis-attributes processes — the exact
 * mistake that ownership is supposed to prevent.
 *
 * Output is a process set (`p<pid>`, `c<command>`) followed by its file sets
 * (`f<fd>`, `t<IPv4|IPv6>`, `n<addr:port>`), repeating.
 */
export function parseLsofListeners(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  let pid: number | null = null;
  let command = '';
  let family: 'IPv4' | 'IPv6' | null = null;

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);

    switch (tag) {
      case 'p': {
        const parsed = Number.parseInt(value, 10);
        pid = Number.isNaN(parsed) ? null : parsed;
        command = '';
        family = null;
        break;
      }
      case 'c':
        command = value;
        break;
      case 't':
        family = value === 'IPv4' || value === 'IPv6' ? value : null;
        break;
      case 'n': {
        // '127.0.0.1:59524' | '*:7000' | '[::1]:9333'. Port is after the last
        // colon; IPv6 addresses keep their brackets and their inner colons.
        const cut = value.lastIndexOf(':');
        if (pid === null || family === null || cut < 0) break;
        const port = Number.parseInt(value.slice(cut + 1), 10);
        if (Number.isNaN(port) || port <= 0 || port > 65535) break;
        listeners.push({ pid, command, family, address: value.slice(0, cut), port });
        break;
      }
      default:
        // f<fd> and any other field — irrelevant here
        break;
    }
  }

  return listeners;
}

/**
 * Split a `ps -o command=` line into its `--flags`.
 *
 * Chrome command lines cannot be split on whitespace: values contain spaces
 * (`--user-data-dir=/Users/me/my profiles/a`) and trailing positionals are
 * start URLs. So segments are cut at ` --` boundaries instead. A value that
 * itself contains " --" would be cut short; no such value exists in what tirno
 * passes, and guessing wrong fails closed (an unmatched flag reads as drift or
 * as foreign, never as agreement).
 *
 * Valueless flags map to null, which is distinct from an empty value.
 */
export function parseFlags(cmdline: string): Map<string, string | null> {
  const flags = new Map<string, string | null>();

  for (const segment of cmdline.split(/\s+(?=--)/)) {
    if (!segment.startsWith('--')) continue;      // executable path, positionals
    const eq = segment.indexOf('=');
    if (eq === -1) {
      // `--no-first-run about:blank` — the positional after it is not a value
      flags.set(segment.split(/\s/)[0], null);
    } else {
      // 크롬이 cmdline 끝에 붙이는 트레일링 positional(start URL)이 마지막 세그먼트의
      // 값에 섞인다 — 보통은 그 앞에 다른 --flag 가 와서 잘리지만, --extensions 로
      // --disable-extensions 를 빼면 `--user-data-dir=/path about:blank` 처럼 값에
      // 바로 붙는다. 값에 정당한 공백이 있을 수 있어(경로) 무조건 자르지 않고,
      // **마지막 토큰이 start-URL 꼴일 때만** 떼어낸다.
      const raw = segment.slice(eq + 1).trim();
      const url = raw.match(/\s+(?:about:|chrome:\/\/|https?:\/\/|file:\/\/|data:)\S*$/);
      flags.set(segment.slice(0, eq), url ? raw.slice(0, url.index).trim() : raw);
    }
  }

  return flags;
}

/** Convenience for the ownership check — see parseFlags for the parsing rules. */
export function parseUserDataDir(cmdline: string): string | null {
  return parseFlags(cmdline).get('--user-data-dir') || null;
}

// ------------------------------------------------------------ classifying

/**
 * Three facts must agree for `ours`. Each one alone is forgeable:
 * a pid can be recycled, a port can be inherited by an unrelated process, and a
 * matching command name proves nothing about which profile it opened.
 */
export function classify(obs: Observation): Verdict {
  // 못 봤으면 못 봤다고 한다. 빈 목록으로 판정하면 "nothing listens" 가 되고, 그것은
  // 관측이 아니라 관측 도구의 부재다.
  if (obs.listenersUnavailable) {
    return { ownership: 'unknown', reason: `cannot observe listeners — ${obs.listenersUnavailable}` };
  }
  const pids = new Set(obs.listeners.map(l => l.pid));

  // Checked first, and deliberately: two processes on one port (an old chrome on
  // IPv4, a new one on IPv6) is where mis-attribution happens. Whatever else
  // looks right, nothing may be acted on automatically here.
  if (pids.size > 1) {
    const who = [...pids].map(p => {
      const l = obs.listeners.find(x => x.pid === p);
      return `${l?.command ?? '?'}(pid ${p}, ${l?.family})`;
    }).join(' + ');
    return {
      ownership: 'ambiguous',
      reason: `port ${obs.resolvedPort} has ${pids.size} listeners: ${who}`,
    };
  }

  if (obs.resolvedPort === null) {
    return { ownership: 'ghost', reason: `no port recorded and no DevToolsActivePort` };
  }

  if (!obs.pidAlive && obs.listeners.length === 0) {
    return { ownership: 'ghost', reason: `pid ${obs.pid} is gone and nothing listens on ${obs.resolvedPort}` };
  }

  // fact 1 — the recorded process still exists
  if (!obs.pidAlive) {
    const l = obs.listeners[0];
    return {
      ownership: 'foreign',
      reason: `pid ${obs.pid} is gone; port ${obs.resolvedPort} now belongs to ${l.command} (pid ${l.pid})`,
    };
  }

  // fact 2 — and it is the one holding this port
  if (obs.listeners.length === 0) {
    return {
      ownership: 'foreign',
      reason: `pid ${obs.pid} is alive but nothing listens on port ${obs.resolvedPort}`,
    };
  }
  if (!pids.has(obs.pid)) {
    const l = obs.listeners[0];
    return {
      ownership: 'foreign',
      reason: `port ${obs.resolvedPort} is held by ${l.command} (pid ${l.pid}), not by pid ${obs.pid}`,
    };
  }

  // fact 3 — and it opened the profile this session owns
  if (obs.runningUserDataDir === null) {
    return {
      ownership: 'foreign',
      reason: `pid ${obs.pid} has no readable --user-data-dir; cannot confirm it opened ${obs.expectedUserDataDir}`,
    };
  }
  if (obs.runningUserDataDir !== obs.expectedUserDataDir) {
    return {
      ownership: 'foreign',
      reason: `pid ${obs.pid} runs with --user-data-dir=${obs.runningUserDataDir}, not ${obs.expectedUserDataDir}`,
    };
  }

  return { ownership: 'ours', reason: `pid ${obs.pid} listens on ${obs.resolvedPort} with ${obs.expectedUserDataDir}` };
}

// ------------------------------------------------------------------- I/O

export type InventoryBackend = 'lsof' | 'proc';

export interface ListenerScan {
  listeners: Listener[];
  backend: InventoryBackend;
  /** 스캔이 실패했으면 그 이유. 이때 `listeners` 는 빈 배열이지 "없다" 가 아니다 */
  failure?: string;
}

/**
 * 어느 백엔드로 볼지. `TIRNO_INVENTORY=lsof|proc` 가 이기고, 아니면 linux 에서 /proc 이
 * 읽히면 proc(외부 바이너리 0개), 그 외는 lsof.
 */
export function pickBackend(env: NodeJS.ProcessEnv = process.env, platform = process.platform): InventoryBackend {
  const forced = env['TIRNO_INVENTORY'];
  if (forced === 'lsof' || forced === 'proc') return forced;
  if (platform === 'linux') {
    try {
      fs.accessSync('/proc/net/tcp', fs.constants.R_OK);
      return 'proc';
    } catch {
      return 'lsof';
    }
  }
  return 'lsof';
}

async function scanWithLsof(): Promise<ListenerScan> {
  try {
    const { stdout } = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcnt'], {
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { listeners: parseLsofListeners(stdout), backend: 'lsof' };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; killed?: boolean };
    // 바이너리가 없는 것만 관측 실패다. lsof 는 리스너가 하나도 없어도, 일부 프로세스를
    // 못 읽어도 exit 1 이므로, 그 경우 stdout(빈 것 포함)을 그대로 쓴다.
    if (err.code === 'ENOENT') {
      return { listeners: [], backend: 'lsof', failure: 'lsof is not installed (install it, or set TIRNO_INVENTORY=proc on linux)' };
    }
    if (err.killed) return { listeners: [], backend: 'lsof', failure: 'lsof timed out after 10s' };
    return { listeners: parseLsofListeners(err.stdout ?? ''), backend: 'lsof' };
  }
}

/** Every TCP listener on this machine, with whether the scan itself worked. */
export async function scanListeners(backend: InventoryBackend = pickBackend()): Promise<ListenerScan> {
  if (backend === 'proc') {
    try {
      return { listeners: scanProcListeners(), backend };
    } catch (e) {
      return { listeners: [], backend, failure: `/proc scan failed: ${(e as Error).message}` };
    }
  }
  return scanWithLsof();
}

/**
 * @deprecated 실패를 값으로 접는다 — 호출자가 "못 봤다" 와 "없다" 를 구별할 수 없다.
 * `scanListeners()` 를 쓰고 `inspectSession` 에 그 결과를 넘겨라.
 */
export async function collectListeners(): Promise<Listener[]> {
  return (await scanListeners()).listeners;
}

export async function readCmdline(pid: number): Promise<string | null> {
  // linux 는 /proc 이 먼저다 — ps 가 없는 이미지에서도 읽히고, 인자 경계가 NUL 이라
  // 값 속 공백을 잘못 나눌 일이 없다.
  if (process.platform === 'linux') {
    try {
      const fromProc = cmdlineFromProc(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
      if (fromProc) return fromProc;
    } catch {
      // 없거나(죽음) 못 읽음(남의 것) — ps 로 한 번 더
    }
  }
  try {
    const { stdout } = await exec('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve symlinks so an anchored profile and its target compare equal. Falls
 * back to a lexical resolve when the path is gone.
 */
function normalizeDir(dir: string): string {
  try {
    return fs.realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

export interface SessionInventory extends Verdict {
  name: string;
  pid: number;
  resolvedPort: number | null;
  listeners: Listener[];
  /** ws endpoint to connect to when `ours` */
  wsEndpoint: string;
}

/**
 * Observe one session. `listeners` may be passed in when inspecting several
 * sessions so lsof runs once instead of per session.
 */
export async function inspectSession(
  meta: SessionMetadata,
  scan?: ListenerScan | Listener[],
): Promise<SessionInventory> {
  if (isExternal(meta)) {
    const probe = await probeDevTools(httpBaseOf(meta.wsEndpoint));
    return {
      ownership: probe ? 'external' : 'ghost',
      reason: probe
        ? `external endpoint ${meta.wsEndpoint} answers (${probe.browser}); not launched by tirno, so its process is not tirno's to manage`
        : `external endpoint ${meta.wsEndpoint} does not answer /json/version`,
      name: meta.name,
      pid: 0,
      resolvedPort: meta.port,
      listeners: [],
      wsEndpoint: probe?.wsEndpoint ?? meta.wsEndpoint,
    };
  }
  const active = readActivePort(meta.userDataDir);
  const resolvedPort = active?.port ?? meta.port ?? null;
  // 배열을 넘기는 옛 호출은 "스캔이 됐다" 로 본다 — 실패를 알릴 수 있는 것은 ListenerScan 뿐
  const resolved: ListenerScan = scan === undefined
    ? await scanListeners()
    : Array.isArray(scan) ? { listeners: scan, backend: pickBackend() } : scan;
  const listeners = resolved.listeners.filter(l => l.port === resolvedPort);
  const pidAlive = isAlive(meta.pid);
  const cmdline = pidAlive ? await readCmdline(meta.pid) : null;
  const runningUserDataDir = cmdline ? parseUserDataDir(cmdline) : null;

  const verdict = classify({
    resolvedPort,
    pidAlive,
    listeners,
    listenersUnavailable: resolved.failure,
    runningUserDataDir: runningUserDataDir === null ? null : normalizeDir(runningUserDataDir),
    expectedUserDataDir: normalizeDir(meta.userDataDir),
    pid: meta.pid,
  });

  return {
    ...verdict,
    name: meta.name,
    pid: meta.pid,
    resolvedPort,
    listeners,
    wsEndpoint: active?.wsEndpoint ?? meta.wsEndpoint,
  };
}
