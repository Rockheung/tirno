import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { intArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { fetchBody, fileNameFor, listResources, matchesFilter, type PageResource } from '../cdp/resources.js';
import { formatTable, success, info, warn, error } from '../output/formatter.js';

/**
 * 이 세션이 **이미 받은** 리소스.
 *
 * `network` 와 다른 명령인 이유: `network` 는 reload 해서 그 한 번의 왕복을 본다.
 * 여기 둘은 reload 하지 않고, 요청 시점에 듣고 있지 않아도 되며, 캐러셀을 13라운드
 * 돌며 여러 명령에 걸쳐 쌓인 것도 그대로 남아 있다. 명령마다 CDP 를 붙였다 끊는
 * 구조에서 그것이 가능한 이유는 렌더러가 그 응답을 들고 있기 때문이다.
 *
 * `record` / `trail` / `cache` 가 이미 "관찰한 것을 적어두는" 계열인데 네트워크
 * 본문만 비어 있었다 (#136).
 */
export function registerNetCommands(program: Command): void {
  const net = program
    .command('net')
    .description('Resources this session already received — list them, or write their bytes to disk');

  net
    .command('ls')
    .description('What this page has received. No reload, no listener — the renderer already has it')
    .option('-s, --session <name>', 'Session name')
    .option('--filter <pattern>', 'Match anywhere in the URL. `*` and `?` are wildcards')
    .option('--type <type>', 'Resource type (image|script|document|stylesheet|font|xhr|fetch|media|…)')
    .option('--limit <n>', 'Max rows', intArg, 100)
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const cdp = await page.createCDPSession();
        const all = await listResources(cdp);
        await cdp.detach();
        browser.disconnect();

        const hits = select(all, opts.filter, opts.type);

        if (opts.json) {
          console.log(JSON.stringify(hits, null, 2));
          return;
        }
        if (hits.length === 0) {
          info(all.length === 0
            ? 'No resources recorded for this page yet.'
            : `No match among ${all.length} resource(s).`);
          return;
        }
        console.log(formatTable(['TYPE', 'SIZE', 'MIME', 'URL'], hits.slice(0, opts.limit).map(r => [
          r.type,
          r.contentSize ? String(r.contentSize) : '-',
          r.mimeType || '-',
          r.url.length > 90 ? r.url.slice(0, 87) + '...' : r.url,
        ])));
        info(`${hits.length} of ${all.length} resource(s)${hits.length > opts.limit ? ` — showing ${opts.limit}, raise --limit` : ''}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  net
    .command('save')
    .description('Write those response bodies to disk — the bytes the browser already has')
    .argument('[pattern]', 'Match anywhere in the URL. `*` and `?` are wildcards. Omit to save everything')
    .option('-s, --session <name>', 'Session name')
    .option('--out <dir>', 'Output directory', '.')
    .option('--type <type>', 'Resource type (image|script|document|…)')
    .option('--limit <n>', 'Refuse to write more files than this', intArg, 200)
    .option('--json', 'Output as JSON')
    .action(async (pattern: string | undefined, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const cdp = await page.createCDPSession();
        const all = await listResources(cdp);
        const hits = select(all, pattern, opts.type);

        if (hits.length === 0) {
          await cdp.detach();
          browser.disconnect();
          throw new Error(all.length === 0
            ? 'No resources recorded for this page yet.'
            : `No match among ${all.length} resource(s). Try "tirno net ls" first.`);
        }
        // 세어보고 멈춘다. 패턴이 넓은 줄 모르고 부른 것과, 정말 그만큼 원한 것은
        // 다르고, 그 차이는 디렉터리에 2000개가 쌓인 뒤에는 되돌리기 어렵다.
        if (hits.length > opts.limit) {
          await cdp.detach();
          browser.disconnect();
          throw new Error(`${hits.length} resources match, over --limit ${opts.limit}. Narrow the pattern or raise --limit.`);
        }

        fs.mkdirSync(opts.out, { recursive: true });
        const taken = new Set<string>();
        const saved: Array<{ file: string; bytes: number; source: string; url: string }> = [];
        const failed: Array<{ url: string; reason: string }> = [];

        for (const r of hits) {
          const name = fileNameFor(r.url, r.mimeType, taken);
          try {
            const body = await fetchBody(cdp, r);
            const dest = path.join(opts.out, name);
            fs.writeFileSync(dest, body.bytes);
            saved.push({ file: dest, bytes: body.bytes.length, source: body.source, url: r.url });
          } catch (e) {
            // 한 장이 안 된다고 나머지를 버리지 않는다. 무엇이 빠졌는지는 끝에 말한다.
            failed.push({ url: r.url, reason: (e as Error).message });
          }
        }

        await cdp.detach();
        browser.disconnect();

        if (opts.json) {
          console.log(JSON.stringify({ saved, failed }, null, 2));
          if (failed.length) process.exit(1);
          return;
        }

        if (saved.length) {
          console.log(formatTable(['FILE', 'BYTES', 'FROM'], saved.map(x => [x.file, String(x.bytes), x.source])));
        }
        success(`${saved.length} file(s) → ${opts.out}`);
        // 어디서 온 바이트인지 말한다. cache 는 브라우저가 실제로 받은 그 응답이고,
        // re-fetch 는 지금 다시 받은 것이라 그 사이에 바뀌었을 수 있다.
        const refetched = saved.filter(x => x.source === 're-fetch').length;
        if (refetched) {
          info(`${refetched} re-fetched by the browser (evicted from the renderer's cache) — cookies/Referer/UA were still the browser's`);
        }
        if (failed.length) {
          warn(`${failed.length} failed:`);
          for (const f of failed.slice(0, 10)) console.log(`  ${f.url.slice(0, 90)} — ${f.reason}`);
          process.exit(1);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}

/** `ls` 와 `save` 가 같은 규칙으로 고른다 — ls 로 확인한 것이 save 되어야 한다. */
export function select(all: PageResource[], pattern: string | undefined, type: string | undefined): PageResource[] {
  return all.filter(r => {
    if (type && r.type.toLowerCase() !== type.toLowerCase()) return false;
    if (pattern && !matchesFilter(r.url, pattern)) return false;
    return true;
  });
}
