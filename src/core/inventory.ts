import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionMetadata } from './session-store.js';
import { isAlive } from './process-guard.js';
import { readActivePort } from './devtools-port.js';

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

export type Ownership = 'ours' | 'foreign' | 'ambiguous' | 'ghost';

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
      flags.set(segment.slice(0, eq), segment.slice(eq + 1).trim());
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

/** Every TCP listener on this machine. Returns [] if lsof is unavailable. */
export async function collectListeners(): Promise<Listener[]> {
  try {
    // lsof exits non-zero when some processes are unreadable; partial output on
    // stdout is still usable, so the error path reads stdout too.
    const { stdout } = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcnt'], {
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseLsofListeners(stdout);
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout;
    return stdout ? parseLsofListeners(stdout) : [];
  }
}

export async function readCmdline(pid: number): Promise<string | null> {
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
export function normalizeDir(dir: string): string {
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
  allListeners?: Listener[],
): Promise<SessionInventory> {
  const active = readActivePort(meta.userDataDir);
  const resolvedPort = active?.port ?? meta.port ?? null;
  const listeners = (allListeners ?? await collectListeners()).filter(l => l.port === resolvedPort);
  const pidAlive = isAlive(meta.pid);
  const cmdline = pidAlive ? await readCmdline(meta.pid) : null;
  const runningUserDataDir = cmdline ? parseUserDataDir(cmdline) : null;

  const verdict = classify({
    resolvedPort,
    pidAlive,
    listeners,
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
