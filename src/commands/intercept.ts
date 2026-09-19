import { Command } from 'commander';
import * as store from '../core/session-store.js';
import { writeHeaderExtFor, loadHeaderExt, requireExtensions, type InterceptRule } from '../core/header-ext.js';
import { formatTable, success, info, fail } from '../output/formatter.js';

// 요청 차단·모킹 — `headers` 가 쓰는 declarativeNetRequest 확장 위에 얹는다(#178).
// 데몬이 아니다: page 타깃의 Fetch 인터셉트는 서비스워커·OOPIF 를 못 보고, 응답을 못
// 하는 동안 요청이 매달린다(#122). 확장 규칙은 브라우저 네트워크 스택에 걸려 둘 다 덮는다.
//
// mock 은 redirect → data: URL 이라 상태 코드가 늘 200 이다. `--status` 는 없다.

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function resolveName(opts: { session?: string }): string {
  const name = opts.session ?? store.getActive();
  if (!name) throw new Error('No active session');
  return name;
}

function nextId(rules: InterceptRule[]): string {
  const n = rules.reduce((m, r) => Math.max(m, Number(/^ic(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
  return `ic${n + 1}`;
}

async function add(opts: { session?: string; host?: string[] }, rule: Omit<InterceptRule, 'id'>): Promise<InterceptRule> {
  const name = resolveName(opts);
  const meta = store.get(name);
  requireExtensions(name, meta, 'a request rule');
  if (!rule.pattern.trim()) throw new Error('Empty pattern — give a declarativeNetRequest urlFilter, e.g. /ads/ or ||cdn.example.com/');
  const cur = meta.interceptRules ?? [];
  const full: InterceptRule = { id: nextId(cur), ...rule };
  store.update(name, { interceptRules: [...cur, full] });
  await loadHeaderExt(name);
  return full;
}

const scope = (r: Pick<InterceptRule, 'hosts'>): string => r.hosts?.length ? `hosts: ${r.hosts.join(', ')}` : 'every host';

export function registerInterceptCommands(program: Command): void {
  const cmd = program
    .command('intercept')
    .description('Block or mock requests — rules baked into the same declarativeNetRequest extension as `headers`, so they hold after tirno disconnects and reach service-worker and OOPIF requests. Needs a session launched with --extensions');

  cmd.addHelpText('after', INTERCEPT_HELP);

  cmd
    .command('block')
    .description('Requests matching the pattern never leave the browser')
    .argument('<pattern>', 'declarativeNetRequest urlFilter — /ads/ (substring), ||host/ (domain anchor), * and ^ wildcards')
    .option('-s, --session <name>', 'Session name')
    .option('--host <domain>', 'Only on this host — registrable domain, subdomains included (repeatable)', collect, [])
    .action(async (pattern: string, opts) => {
      try {
        const r = await add(opts, { kind: 'block', pattern, ...(opts.host?.length ? { hosts: opts.host } : {}) });
        success(`${r.id} block ${pattern} (${scope(r)})`);
      } catch (e) { fail(e); }
    });

  cmd
    .command('mock')
    .description('Requests matching the pattern get this body instead — always status 200 (a redirect to a data: URL); the origin is never contacted')
    .argument('<pattern>', 'declarativeNetRequest urlFilter, as for block')
    .requiredOption('--body <text>', 'Response body')
    .option('--content-type <type>', 'Response content-type', 'application/json')
    .option('-s, --session <name>', 'Session name')
    .option('--host <domain>', 'Only on this host — registrable domain, subdomains included (repeatable)', collect, [])
    .action(async (pattern: string, opts) => {
      try {
        const r = await add(opts, { kind: 'mock', pattern, body: String(opts.body), contentType: opts.contentType, ...(opts.host?.length ? { hosts: opts.host } : {}) });
        success(`${r.id} mock ${pattern} → ${opts.contentType}, ${Buffer.byteLength(String(opts.body))} bytes, status 200 (${scope(r)})`);
      } catch (e) { fail(e); }
    });

  cmd
    .command('rm')
    .description('Remove one rule by id, or every rule with --all. Rewrites the extension rules and reloads them')
    .argument('[id]', 'Rule id from `intercept ls`')
    .option('--all', 'Remove every rule')
    .option('-s, --session <name>', 'Session name')
    .action(async (id: string | undefined, opts) => {
      try {
        if (!id && !opts.all) throw new Error('Give a rule id, or --all');
        const name = resolveName(opts);
        const meta = store.get(name);
        const cur = meta.interceptRules ?? [];
        if (id && !cur.some(r => r.id === id)) { info(`No rule '${id}' — \`tirno intercept ls\``); return; }
        const next = opts.all ? [] : cur.filter(r => r.id !== id);
        store.update(name, { interceptRules: next });
        // headers rm 과 같다 — 확장이 꺼진 세션이면 파일만 갱신하고 다음 restart 가 읽는다
        if (meta.extensions) await loadHeaderExt(name);
        else writeHeaderExtFor(store.get(name));
        success(opts.all ? `Removed ${cur.length} rule${cur.length === 1 ? '' : 's'}` : `Removed ${id}`);
      } catch (e) { fail(e); }
    });

  cmd
    .command('ls')
    .description('List block/mock rules for a session')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      try {
        const name = resolveName(opts);
        const rules = store.get(name).interceptRules ?? [];
        if (opts.json) { console.log(JSON.stringify({ rules }, null, 2)); return; }
        if (!rules.length) { info(`No intercept rules for '${name}'.`); return; }
        console.log(formatTable(
          ['ID', 'KIND', 'PATTERN', 'HOSTS', 'RESPONSE'],
          rules.map(r => [r.id, r.kind, r.pattern, r.hosts?.join(', ') ?? '*', r.kind === 'mock' ? `200 ${r.contentType} (${Buffer.byteLength(r.body ?? '')} bytes)` : '—']),
        ));
      } catch (e) { fail(e); }
    });
}

const INTERCEPT_HELP = `
Rules live in the tirno-headers extension inside the session profile, next to
\`headers\` rules. They sit in the browser network stack: a blocked request never
reaches the server — including requests a service worker or an out-of-process
iframe makes on its own — and a mocked one gets the given body without the
origin being contacted. The session must run with --extensions;
\`tirno restart <name>\` brings stored rules back.

  block   action "block". Pattern is a declarativeNetRequest urlFilter:
          /ads/ matches anywhere in the URL, ||cdn.example.com/ anchors a domain,
          * is a wildcard, ^ a separator.
  mock    action "redirect" to a data: URL. The status is therefore ALWAYS 200 —
          there is no --status. For a 5xx, serve it from a real origin
          (tirno-origin-relay) instead.

Header rules and block/mock rules are different actions and do not shadow each
other; when block and mock both match one request, block wins.

Examples:
  tirno intercept block '/ads/'                                   every host
  tirno intercept block '||tracker.example.com/'                  that domain
  tirno intercept mock '/api/user' --body '{"error":"down"}'       200 + JSON
  tirno intercept mock '/api/user' --body '' --host api.acme.com   empty body, one host
  tirno intercept ls · tirno intercept rm ic1 · tirno intercept rm --all
`;
