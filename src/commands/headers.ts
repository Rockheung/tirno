import { Command } from 'commander';
import * as store from '../core/session-store.js';
import { connect } from '../core/chrome-connector.js';
import { formatTable, success, info, error } from '../output/formatter.js';

// 모든 요청에 붙는 고정 헤더. 세션 메타에 저장하고 connect 마다 재적용한다
// (Network.setExtraHTTPHeaders 는 연결 수명에 묶인다 — chrome-connector 참조).
//
// 호스트별 필터는 여기 없다. setExtraHTTPHeaders 는 전역이라, 호스트 조건은
// Fetch 인터셉트(상주 연결)가 필요하다 — 별건 이슈.

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
    .description('Add or replace a header on every request')
    .argument('<name>', 'Header name')
    .argument('<value>', 'Header value')
    .option('-s, --session <name>', 'Session name')
    .action(async (hName: string, hValue: string, opts) => {
      try {
        const name = opts.session ?? store.getActive();
        if (!name) throw new Error('No active session');
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
        if (opts.json) { console.log(JSON.stringify(h, null, 2)); return; }
        const keys = Object.keys(h);
        if (!keys.length) { info(`No fixed headers for '${name}'.`); return; }
        console.log(formatTable(['HEADER', 'VALUE'], keys.map(k => [k, h[k]])));
      } catch (e) { error((e as Error).message); process.exit(1); }
    });
}
