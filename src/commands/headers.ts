import { Command } from 'commander';
import * as store from '../core/session-store.js';
import { connect } from '../core/chrome-connector.js';
import { writeHeaderExt, loadHeaderExt, type HeaderRule } from '../core/header-ext.js';
import { formatTable, success, info, error } from '../output/formatter.js';

// 두 경로가 있고, 어느 쪽인지는 `--once` 하나로 갈린다.
//
// 기본은 프로필 안에 구운 declarativeNetRequest 확장이다(core/header-ext). 규칙이
// 브라우저 네트워크 스택에 걸리므로 CDP 연결이 끊긴 뒤에도, 서비스워커와 OOPIF 가
// 보내는 요청에도 붙고, 호스트 조건을 받는다.
//
// `--once` 는 Network.setExtraHTTPHeaders 다. 연결 수명에 묶여 tirno 명령이 도는
// 동안만 붙고 호스트 조건도 없지만, `--extensions` 없이 뜬 세션에서 쓸 수 있는
// 것은 이쪽뿐이다.

// 확장 경로에서만 부른다 — 호출 전에 세션이 확장을 받을 수 있는지 판정해야 한다.
function requireExtensions(name: string, meta: store.SessionMetadata): void {
  if (meta.extensions) return;
  throw new Error(
    `Session '${name}' runs with extensions off, and a persistent header is an extension. ` +
    `Re-launch with \`tirno restart ${name} --extensions\` (stored rules come back with it), ` +
    `or add --once for a header that only lasts while a tirno command runs.`
  );
}

/** `--once` 경로. connect 가 저장된 extraHeaders 를 재적용한다. */
async function applyOnce(name: string): Promise<void> {
  const { browser } = await connect(name);
  browser.disconnect();
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function resolveName(opts: { session?: string }): string {
  const name = opts.session ?? store.getActive();
  if (!name) throw new Error('No active session');
  return name;
}

export function registerHeaderCommands(program: Command): void {
  const cmd = program
    .command('headers')
    .description('Fixed headers added to requests — persistent by default, --once for connection-scoped');

  cmd.addHelpText('after', HEADERS_HELP);

  cmd
    .command('set')
    .description('Add or replace a request header. Persists as a declarativeNetRequest extension in the session profile — outlives the CDP connection and reaches service-worker and OOPIF requests. Needs a session launched with --extensions')
    .argument('<name>', 'Header name')
    .argument('<value>', 'Header value')
    .option('-s, --session <name>', 'Session name')
    .option('--host <domain>', 'Only add the header on this host — matched as a registrable domain, subdomains included (repeatable). Omit for every request', collect, [])
    .option('--once', 'Use Network.setExtraHTTPHeaders instead — lasts only while a tirno command holds the connection, and takes no --host')
    .action(async (hName: string, hValue: string, opts) => {
      try {
        const name = resolveName(opts);
        const hosts: string[] = opts.host ?? [];
        if (opts.once && hosts.length) {
          throw new Error('--once cannot take --host: setExtraHTTPHeaders applies to every request. Drop one of the two.');
        }
        const meta = store.get(name);

        if (opts.once) {
          store.update(name, { extraHeaders: { ...(meta.extraHeaders ?? {}), [hName]: hValue } });
          await applyOnce(name);
          success(`${hName}: ${hValue} (once — only while a tirno command is connected)`);
          return;
        }

        requireExtensions(name, meta);
        const rule: HeaderRule = { name: hName, value: hValue, ...(hosts.length ? { hosts } : {}) };
        const next = [...(meta.headerRules ?? []).filter(r => r.name !== hName), rule];
        store.update(name, { headerRules: next });
        await loadHeaderExt(name);
        success(`${hName}: ${hValue}${hosts.length ? ` (hosts: ${hosts.join(', ')})` : ' (every host)'}`);
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('rm')
    .description('Remove one header, or all when none is given. Rewrites the extension rules and reloads them; --once removes from the setExtraHTTPHeaders set instead')
    .argument('[name]', 'Header name; omit to clear all')
    .option('-s, --session <name>', 'Session name')
    .option('--once', 'Remove from the --once set instead')
    .action(async (hName: string | undefined, opts) => {
      try {
        const name = resolveName(opts);
        const meta = store.get(name);

        if (opts.once) {
          const cur = meta.extraHeaders ?? {};
          if (hName && !(hName in cur)) { info(`No --once header '${hName}' set.`); return; }
          const next = { ...cur };
          if (hName) delete next[hName]; else for (const k of Object.keys(next)) delete next[k];
          store.update(name, { extraHeaders: next });
          await applyOnce(name);
          success(hName ? `Removed ${hName} (once)` : 'Cleared all --once headers');
          return;
        }

        const cur = meta.headerRules ?? [];
        if (hName && !cur.some(r => r.name === hName)) { info(`No header '${hName}' set.`); return; }
        store.update(name, { headerRules: hName ? cur.filter(r => r.name !== hName) : [] });
        // extensions 가 꺼진 세션이면 확장 자체가 떠 있지 않다 — 규칙 파일만 갱신하고
        // 로드는 건너뛴다. 다음 `restart --extensions` 가 갱신된 파일을 읽는다.
        if (meta.extensions) await loadHeaderExt(name);
        else writeHeaderExt(meta.userDataDir, store.get(name).headerRules ?? []);
        success(hName ? `Removed ${hName}` : 'Cleared all headers');
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('ls')
    .description('List headers for a session, each with the hosts it is scoped to and whether it persists past the connection')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      try {
        const name = resolveName(opts);
        const meta = store.get(name);
        const rules = meta.headerRules ?? [];
        const once = meta.extraHeaders ?? {};
        if (opts.json) { console.log(JSON.stringify({ headerRules: rules, once }, null, 2)); return; }
        const rows = [
          ...rules.map(r => [r.name, r.value, r.hosts?.join(', ') ?? '*', 'persistent']),
          ...Object.entries(once).map(([k, v]) => [k, v, '*', 'once']),
        ];
        if (!rows.length) { info(`No fixed headers for '${name}'.`); return; }
        console.log(formatTable(['HEADER', 'VALUE', 'HOSTS', 'SCOPE'], rows));
      } catch (e) { error((e as Error).message); process.exit(1); }
    });
}

const HEADERS_HELP = `
Two mechanisms, chosen by --once:

  default   A declarativeNetRequest extension baked into the session profile at
            <user-data-dir>/tirno-headers. The rules sit in the browser network
            stack, so they hold after tirno disconnects, apply to requests a
            service worker or an out-of-process iframe makes on its own, and
            take a --host condition. The session must run with --extensions.
            \`tirno restart <name>\` brings stored rules back and turns
            extensions on by itself when there are any; an extension only
            attaches after launch, so a boot URL is reloaded once rules are in.

  --once    Network.setExtraHTTPHeaders, re-applied on every connect. It is
            bound to the CDP connection, so the header is only on requests that
            happen while a tirno command is running — nothing the page sends on
            its own afterwards carries it — and it cannot be scoped to a host.
            This is the only path on a session without --extensions.

Examples:
  tirno headers set X-Debug 1                      every request, persistent
  tirno headers set X-Key abc --host api.acme.com  that host only
  tirno headers set X-Key abc --once               while tirno commands run
  tirno headers ls                                 both sets, with their scope
`;
