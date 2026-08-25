import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { intArg } from '../util/parsers.js';
import * as store from '../core/session-store.js';
import * as rules from '../core/intercept-store.js';
import { underRoot } from '../core/paths.js';
import { formatTable, success, info, warn, error } from '../output/formatter.js';

/**
 * 요청 가로채기 — 차단 · 모킹 · 호스트별 헤더.
 *
 * 헤더 규칙을 여기서 **만들지는** 않는다. 그 문은 `headers set --host` 다 — 헤더를 찾는
 * 사람이 보는 자리가 거기이고, 같은 것을 두 군데서 만들 수 있으면 어느 쪽이 정본인지가
 * 매번 질문이 된다. 여기서는 만들어진 규칙을 **보고 지운다**.
 *
 * 규칙은 세션 메타에 남지만, **데몬이 붙어 있어야 실제로 먹는다** (#122). 그래서 규칙을
 * 더하면 데몬을 자동으로 띄운다 — "규칙은 저장됐는데 아무 일도 안 일어난다" 가 이 자리의
 * 조용한 실패 형태이고, 그것을 사용자가 알아채려면 무엇이 잘못됐는지 짐작해야 한다.
 *
 * `stop` 은 규칙을 지우지 않는다. 잠깐 끄는 것과 그만두는 것은 다르다.
 */

interface DaemonPaths { dir: string; pid: string; stats: string; log: string }

function daemonPaths(session: string): DaemonPaths {
  const dir = underRoot('intercept', session);
  return {
    dir,
    pid: path.join(dir, '.pid'),
    stats: path.join(dir, 'stats.json'),
    log: path.join(dir, 'worker.log'),
  };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function runningPid(session: string): number | null {
  const { pid: pidFile } = daemonPaths(session);
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
  if (!Number.isFinite(pid) || !pidAlive(pid)) return null;
  return pid;
}

function resolveSession(name?: string): string {
  const session = name ?? store.getActive();
  if (!session) throw new Error('No active session — pass --session or run `tirno attach`');
  store.get(session);   // 없으면 여기서 던진다
  return session;
}

function workerScript(): string {
  const dir = import.meta.url.startsWith('file://') ? new URL('.', import.meta.url).pathname : __dirname;
  return path.join(dir, 'intercept-worker.js');
}

/** 이미 돌고 있으면 그대로 둔다 — 규칙 파일을 다시 읽으므로 재기동할 이유가 없다. */
export function ensureInterceptDaemon(session: string): { pid: number; started: boolean } {
  const existing = runningPid(session);
  if (existing) return { pid: existing, started: false };

  const meta = store.get(session);
  const paths = daemonPaths(session);
  fs.mkdirSync(paths.dir, { recursive: true });

  const child = spawn(process.execPath, [
    workerScript(),
    '--ws', meta.wsEndpoint,
    '--out', paths.dir,
    '--rules', store.sessionFile(session),
  ], {
    detached: true,
    stdio: ['ignore', 'ignore', fs.openSync(paths.log, 'a')],
  });
  child.unref();
  if (typeof child.pid !== 'number') throw new Error('Failed to spawn the intercept worker');
  fs.writeFileSync(paths.pid, String(child.pid));
  return { pid: child.pid, started: true };
}

function stopDaemon(session: string): number | null {
  const pid = runningPid(session);
  const paths = daemonPaths(session);
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 이미 죽었다 */ }
  }
  try { fs.unlinkSync(paths.pid); } catch { /* 없으면 그만 */ }
  return pid;
}

function readStats(session: string): { seen: number; hits: Record<string, number> } | null {
  try {
    return JSON.parse(fs.readFileSync(daemonPaths(session).stats, 'utf-8')) as
      { seen: number; hits: Record<string, number> };
  } catch {
    return null;
  }
}

/** 규칙을 더한 뒤의 공통 후처리 — 저장했다고만 말하고 끝내면 안 먹는 이유를 알 수 없다. */
function afterAdd(session: string, rule: rules.InterceptRule, json: boolean): void {
  const { pid, started } = ensureInterceptDaemon(session);
  if (json) {
    console.log(JSON.stringify({ rule, daemon: { pid, started } }, null, 2));
    return;
  }
  success(`${rule.id}  ${rules.describe(rule)}`);
  info(started
    ? `intercept daemon started (PID ${pid}) — rules only apply while it runs`
    : `intercept daemon already running (PID ${pid})`);
}

function requireScope(host?: string, url?: string): void {
  if (!host && !url) {
    throw new Error('Give --host and/or a URL pattern. A rule with neither would catch every request.');
  }
}

export function registerInterceptCommands(program: Command): void {
  const cmd = program
    .command('intercept')
    .description('Block, mock, or add headers to matching requests (needs a resident daemon)');

  cmd
    .command('block')
    .description('Fail matching requests, as an ad blocker would')
    .argument('[pattern]', 'URL glob. `*` and `?` are wildcards; both ends are open')
    .option('-s, --session <name>', 'Session name')
    .option('--host <glob>', 'Match on hostname instead of (or as well as) the URL')
    .option('--json', 'Output as JSON')
    .action((pattern: string | undefined, opts) => {
      try {
        const session = resolveSession(opts.session);
        requireScope(opts.host, pattern);
        const rule = rules.add(session, { kind: 'block', host: opts.host, url: pattern });
        afterAdd(session, rule, !!opts.json);
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('mock')
    .description('Answer matching requests from tirno instead of the network')
    .argument('[pattern]', 'URL glob. `*` and `?` are wildcards; both ends are open')
    .option('-s, --session <name>', 'Session name')
    .option('--host <glob>', 'Match on hostname instead of (or as well as) the URL')
    .option('--status <code>', 'Response status', intArg, 200)
    .option('--body <text>', 'Response body')
    .option('--body-file <path>', 'Response body, read from a file')
    .option('--content-type <type>', 'Content-Type; guessed from the body when omitted')
    .option('--json', 'Output as JSON')
    .action((pattern: string | undefined, opts) => {
      try {
        const session = resolveSession(opts.session);
        requireScope(opts.host, pattern);
        if (opts.body !== undefined && opts.bodyFile !== undefined) {
          throw new Error('Pass either --body or --body-file, not both.');
        }
        let body = opts.body as string | undefined;
        if (opts.bodyFile !== undefined) {
          try {
            body = fs.readFileSync(opts.bodyFile, 'utf-8');
          } catch (e) {
            throw new Error(`Cannot read --body-file ${opts.bodyFile}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, { cause: e });
          }
        }
        const rule = rules.add(session, {
          kind: 'mock',
          host: opts.host,
          url: pattern,
          status: opts.status,
          body,
          contentType: opts.contentType,
        });
        afterAdd(session, rule, !!opts.json);
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('ls')
    .description('Rules for this session, in the order they are tried')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      try {
        const session = resolveSession(opts.session);
        const list = rules.list(session);
        const stats = readStats(session);
        const pid = runningPid(session);

        if (opts.json) {
          console.log(JSON.stringify({ rules: list, daemon: pid ? { pid, ...stats } : null }, null, 2));
          return;
        }
        if (!list.length) { info(`No intercept rules for '${session}'.`); return; }
        console.log(formatTable(['ID', 'RULE', 'HITS'], list.map(r => [
          r.id, rules.describe(r), String(stats?.hits[r.id] ?? 0),
        ])));
        // 규칙만 있고 데몬이 없으면 아무 일도 안 일어난다. 그 상태를 조용히 두지 않는다.
        if (!pid) warn('The daemon is not running — these rules are not being applied. Start it: tirno intercept start');
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('rm')
    .description('Remove one rule, or every rule with --all')
    .argument('[id]', 'Rule id from `intercept ls`')
    .option('-s, --session <name>', 'Session name')
    .option('--all', 'Remove every rule')
    .action((id: string | undefined, opts) => {
      try {
        const session = resolveSession(opts.session);
        if (opts.all) {
          const n = rules.clear(session);
          // 마지막 규칙이 사라지면 데몬이 할 일도 없다. 상주 프로세스를 이유 없이 남기지 않는다.
          const pid = stopDaemon(session);
          success(`Removed ${n} rule(s)${pid ? `; daemon stopped (PID ${pid})` : ''}`);
          return;
        }
        if (!id) throw new Error('Give a rule id, or --all. `intercept ls` prints the ids.');
        if (!rules.remove(session, id)) throw new Error(`No rule '${id}'. See \`tirno intercept ls\`.`);
        let note = '';
        if (rules.list(session).length === 0) {
          const pid = stopDaemon(session);
          if (pid) note = `; daemon stopped (PID ${pid})`;
        }
        success(`Removed ${id}${note}`);
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('start')
    .description('Start the daemon without adding a rule')
    .option('-s, --session <name>', 'Session name')
    .action((opts) => {
      try {
        const session = resolveSession(opts.session);
        const { pid, started } = ensureInterceptDaemon(session);
        success(started ? `Started (PID ${pid})` : `Already running (PID ${pid})`);
        if (!rules.list(session).length) info('No rules yet — every request passes through untouched.');
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('stop')
    .description('Stop the daemon. Rules stay — stopping and giving up are different things')
    .option('-s, --session <name>', 'Session name')
    .action((opts) => {
      try {
        const session = resolveSession(opts.session);
        const pid = stopDaemon(session);
        if (!pid) { info('Not running.'); return; }
        success(`Stopped (PID ${pid})`);
        const n = rules.list(session).length;
        if (n) info(`${n} rule(s) kept — start again with \`tirno intercept start\``);
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('status')
    .description('Is the daemon up, and what has it matched')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      try {
        const session = resolveSession(opts.session);
        const pid = runningPid(session);
        const stats = readStats(session);
        const list = rules.list(session);

        if (opts.json) {
          console.log(JSON.stringify({ session, running: pid !== null, pid, rules: list.length, ...stats }, null, 2));
          if (!pid) process.exit(1);
          return;
        }
        if (!pid) {
          warn(`intercept daemon is not running for '${session}' (${list.length} rule(s) stored)`);
          process.exit(1);
        }
        success(`running (PID ${pid}) — ${list.length} rule(s)`);
        // seen 과 hits 를 나눠 보여준다. "규칙이 안 먹는다" 와 "그 요청이 안 왔다" 는
        // 다른 문제이고, 그 둘을 가르는 것은 이 두 숫자뿐이다.
        const matched = Object.values(stats?.hits ?? {}).reduce((a, b) => a + b, 0);
        info(`${stats?.seen ?? 0} request(s) seen, ${matched} matched a rule`);
      } catch (e) { error((e as Error).message); process.exit(1); }
    });
}
