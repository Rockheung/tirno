import { Command } from 'commander';
import * as store from '../core/session-store.js';
import { connect } from '../core/chrome-connector.js';
import { formatTable, success, info, error } from '../output/formatter.js';
import * as rules from '../core/intercept-store.js';
import { ensureInterceptDaemon } from './intercept.js';

// 모든 요청에 붙는 고정 헤더. 세션 메타에 저장하고 connect 마다 재적용한다
// (Network.setExtraHTTPHeaders 는 연결 수명에 묶인다 — chrome-connector 참조).
//
// `--host`/`--url` 을 주면 **다른 기구로 간다.** setExtraHTTPHeaders 는 호스트 조건을
// 받지 않아서, 조건부로 붙이려면 요청마다 URL 을 보고 이어보내야 하고 그것은 상주
// 워커를 요구한다 (#122). 그래서 그때는 intercept 규칙이 되고, 관리도 그쪽에서 한다 —
// 만드는 문은 여기 하나지만 사는 곳은 하나다.

async function apply(name: string): Promise<void> {
  const { browser } = await connect(name);          // connect 가 재적용까지 한다
  browser.disconnect();
}

export function registerHeaderCommands(program: Command): void {
  const cmd = program
    .command('headers')
    .description('Fixed headers added to every request (re-applied each connect; global — no host filter)');

  cmd
    .command('set')
    .description('Add or replace a header — on every request, or only on hosts/URLs that match')
    .argument('<name>', 'Header name')
    .argument('<value>', 'Header value')
    .option('-s, --session <name>', 'Session name')
    .option('--host <glob>', 'Only requests to hostnames matching this glob (needs the intercept daemon)')
    .option('--url <glob>', 'Only requests whose URL matches this glob (needs the intercept daemon)')
    .action(async (hName: string, hValue: string, opts) => {
      try {
        const name = opts.session ?? store.getActive();
        if (!name) throw new Error('No active session');

        // 조건이 붙으면 전역 헤더가 아니다 — 규칙으로 저장하고 워커가 적용한다.
        if (opts.host || opts.url) {
          const rule = rules.add(name, {
            kind: 'header', host: opts.host, url: opts.url, headers: { [hName]: hValue },
          });
          const { pid, started } = ensureInterceptDaemon(name);
          success(`${rule.id}  ${rules.describe(rule)}`);
          info(started
            ? `intercept daemon started (PID ${pid}) — scoped headers only apply while it runs`
            : `intercept daemon already running (PID ${pid})`);
          info(`Manage it with: tirno intercept ls / tirno intercept rm ${rule.id}`);
          return;
        }

        const meta = store.get(name);
        const next = { ...(meta.extraHeaders ?? {}), [hName]: hValue };
        store.update(name, { extraHeaders: next });
        await apply(name);
        success(`${hName}: ${hValue}`);
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('rm')
    .description('Remove one header, or all when none is given')
    .argument('[name]', 'Header name; omit to clear all')
    .option('-s, --session <name>', 'Session name')
    .action(async (hName: string | undefined, opts) => {
      try {
        const name = opts.session ?? store.getActive();
        if (!name) throw new Error('No active session');
        const meta = store.get(name);
        const cur = meta.extraHeaders ?? {};
        let next: Record<string, string>;
        if (hName) {
          if (!(hName in cur)) { info(`No header '${hName}' set.`); return; }
          next = { ...cur }; delete next[hName];
        } else next = {};
        store.update(name, { extraHeaders: next });
        await apply(name);
        success(hName ? `Removed ${hName}` : 'Cleared all headers');
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('ls')
    .description('List fixed headers for a session')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      try {
        const name = opts.session ?? store.getActive();
        if (!name) throw new Error('No active session');
        const h = store.get(name).extraHeaders ?? {};
        const scoped = rules.list(name).filter(r => r.kind === 'header');
        if (opts.json) { console.log(JSON.stringify({ global: h, scoped }, null, 2)); return; }
        const keys = Object.keys(h);
        if (!keys.length) info(`No global headers for '${name}'.`);
        else console.log(formatTable(['HEADER', 'VALUE'], keys.map(k => [k, h[k]])));
        // 호스트/URL 조건이 붙은 것은 여기 표에 안 나온다. 안 보이면 "안 걸었다" 로 읽힌다.
        if (scoped.length) info(`${scoped.length} scoped header rule(s) — see \`tirno intercept ls\``);
      } catch (e) { error((e as Error).message); process.exit(1); }
    });
}
