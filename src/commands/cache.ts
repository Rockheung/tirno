import { Command } from 'commander';
import { intArg } from '../util/parsers.js';
import * as visualCache from '../core/visual-cache.js';
import { formatTable, info, success, fail } from '../output/formatter.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { pageFingerprint, fingerprintBits } from '../cdp/screenshot-hash.js';
import { getActive } from '../core/session-store.js';
import { TirnoError } from '../util/errors.js';
import { judgeFreshness, describeFreshness, formatAge, DEFAULT_STALE_THRESHOLD, type Freshness } from '../core/freshness.js';

/**
 * 지금 화면의 dHash 와 저장값을 대본다. 세션이 없거나(명시도 active 도 없음) --no-compare
 * 면 not-compared. 세션이 **다른 URL** 에 있으면 그것도 not-compared 다 — 다른 페이지와
 * 비교한 거리는 "낡았다" 가 아니라 잡음이다.
 */
async function compareWithSession(
  entry: visualCache.CacheEntry,
  opts: { session?: string; compare?: boolean; staleThreshold: number },
): Promise<Freshness> {
  const base = { capturedAt: entry.capturedAt, storedFp: entry.visualFp, threshold: opts.staleThreshold };
  // 옛 항목의 지문은 9x8 dHash 다 — 정보가 거의 없어 비교해도 뜻이 없다. 다시 찍으라고 한다.
  if (fingerprintBits(entry.visualFp) !== 256) {
    return judgeFreshness({ ...base, reason: 'entry has the old 64-bit fingerprint (near-empty on web pages) — take a fresh `tirno snapshot`' });
  }
  if (opts.compare === false) return judgeFreshness({ ...base, reason: '--no-compare' });
  const sessionName = opts.session ?? getActive() ?? undefined;
  if (!sessionName) return judgeFreshness({ ...base, reason: 'no session (-s <name>, or attach one)' });
  try {
    const { browser } = await connect(sessionName);
    try {
      const page = await getActivePage(browser);
      const here = visualCache.parseUrl(page.url());
      const there = visualCache.parseUrl(entry.url);
      if (here.domain !== there.domain || here.urlPath !== there.urlPath) {
        return judgeFreshness({ ...base, reason: `session '${sessionName}' is on ${page.url()}, not ${entry.url}` });
      }
      const shot = await page.screenshot({ type: 'png', optimizeForSpeed: true }) as Buffer;
      return judgeFreshness({ ...base, currentFp: await pageFingerprint(shot) });
    } finally {
      browser.disconnect();
    }
  } catch (e) {
    return judgeFreshness({ ...base, reason: `could not read session '${sessionName}': ${(e as Error).message}` });
  }
}

export function registerCacheCommands(program: Command): void {
  const cache = program
    .command('cache')
    .description('Visual cache: URL-keyed snapshot store (viewport-aware)');

  cache
    .command('list')
    .description('List cached entries')
    .option('--domain <d>', 'Filter by domain')
    .option('--limit <n>', 'Max entries', intArg, 50)
    .action((opts) => {
      try {
        const entries = visualCache.list({ domain: opts.domain, limit: opts.limit });
        if (entries.length === 0) {
          info('No cache entries');
          return;
        }
        const now = new Date();
        const rows = entries.map(e => [
          e.domain,
          e.urlPath.length > 50 ? e.urlPath.slice(0, 47) + '...' : e.urlPath,
          e.viewport ? visualCache.viewportKey(e.viewport) : '?',
          String(e.refs.length),
          e.visualFp.slice(0, 8),
          // 거리 비교 없이도 "석 달 된 캐시" 는 그 자체로 신호다
          formatAge(now.getTime() - new Date(e.capturedAt).getTime()),
          e.capturedAt.replace('T', ' ').slice(0, 19),
        ]);
        console.log(formatTable(['DOMAIN', 'PATH', 'VIEWPORT', 'REFS', 'FP', 'AGE', 'CAPTURED'], rows));
      } catch (e) {
        fail(e);
      }
    });

  cache
    .command('load <url>')
    .description('Emit cached snapshot for a URL')
    .option('--mode <m>', 'Match mode: exact | urlPath', 'urlPath')
    .option('--viewport <wxh@dpr>', 'Specific viewport (e.g. 1200x800@2). If omitted, most-recent viewport for that URL.')
    .option('--json', 'Output the entry as JSON — the parseable form (adds a `freshness` field)')
    .option('-s, --session <name>', 'Session whose current screen to compare against. Defaults to the active session; with none, no comparison is made and the header says so')
    .option('--no-compare', 'Skip the screenshot comparison even when a session is available')
    .option('--stale-threshold <bits>', 'dHash hamming distance above which the entry is STALE', intArg, DEFAULT_STALE_THRESHOLD)
    .option('--allow-stale', 'Exit 0 even when STALE (it is still printed)')
    .action(async (url, opts) => {
      try {
        // An unknown mode used to fall through to urlPath, so a typo silently
        // widened the match instead of failing.
        if (opts.mode !== 'exact' && opts.mode !== 'urlPath') {
          throw new Error(`--mode must be exact|urlPath, got "${opts.mode}"`);
        }
        let viewport: visualCache.Viewport | undefined;
        if (opts.viewport) {
          const v = visualCache.parseViewportKey(opts.viewport);
          if (!v) throw new Error(`Invalid --viewport. Expected <w>x<h>@<dpr>, got "${opts.viewport}"`);
          viewport = v;
        }
        const entry = visualCache.lookup(url, { mode: opts.mode, viewport });
        if (!entry) {
          info(`No cached entry for ${url} (mode: ${opts.mode}${viewport ? `, viewport: ${visualCache.viewportKey(viewport)}` : ''})`);
          process.exit(1);
        }
        // 지금 화면과 대본다 — 저장만 하고 비교하지 않던 visualFp 가 여기서 쓰인다 (#188).
        // 세션이 없으면 비교하지 않고, 그 사실을 머리글에 적는다.
        const freshness = await compareWithSession(entry, opts);

        // The text form below puts the selector in brackets, and selectors
        // routinely contain brackets themselves (`input[name="q"]`), so it
        // cannot be parsed back. This is the first step of the value flow and
        // its reader is an agent, so it needs a form that survives a round trip.
        if (opts.json) {
          console.log(JSON.stringify({ ...entry, freshness }, null, 2));
        } else {
          console.log(`# cached at ${entry.capturedAt}`);
          console.log(`# url: ${entry.url}`);
          const vp = entry.viewport ? visualCache.viewportKey(entry.viewport) : '?';
          console.log(`# fp: ${entry.visualFp}  viewport: ${vp}  ${describeFreshness(freshness)}`);
        }
        if (freshness.verdict === 'stale' && !opts.allowStale) {
          fail(new TirnoError(
            `cached entry for ${entry.url} is STALE — the page differs by ${freshness.distance}/${freshness.bits} bits (threshold ${freshness.threshold}); take a fresh \`tirno snapshot\`, or --allow-stale to print it anyway`,
            'cache_stale', { distance: freshness.distance, threshold: freshness.threshold, age: freshness.age },
          ));
        }
        if (opts.json) return;
        console.log('');
        for (const r of entry.refs) {
          const a = r.channels.a11y;
          const d = r.channels.dom;
          const v = r.channels.visual;
          const id = (r.refId ?? r.id).padEnd(5);
          const role = a?.role ?? 'text';
          const name = a?.name ? ` "${a.name}"` : (v?.ocrText ? ` ocr:"${v.ocrText.slice(0, 40)}"` : '');
          const sel = d?.selector ? ` [${d.selector}]` : '';
          const bbox = v?.bbox ? ` (${v.bbox.x},${v.bbox.y} ${v.bbox.w}x${v.bbox.h})` : '';
          console.log(`${id} ${role}${name}${sel}${bbox}`);
        }
      } catch (e) {
        fail(e);
      }
    });

  cache
    .command('prune')
    .description('Remove cache entries older than N days (or --all)')
    .option('--older-than <days>', 'Remove entries older than N days', intArg)
    .option('--all', 'Remove every entry, however recent')
    .option('--domain <d>', 'Limit to domain')
    .action((opts) => {
      try {
        // No cutoff used to mean "everything", under a description that said
        // "old" — one word away from emptying the journal this tool exists to
        // keep. `gc` already refuses to delete profiles without --older-than.
        if (opts.olderThan === undefined && !opts.all) {
          throw new Error('Specify --older-than <days>, or --all to remove every entry');
        }
        const { removed } = visualCache.prune({
          olderThanDays: opts.olderThan,
          domain: opts.domain,
        });
        success(`Removed ${removed} entries`);
      } catch (e) {
        fail(e);
      }
    });
}
