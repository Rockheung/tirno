import { Command } from 'commander';
import { intArg } from '../util/parsers.js';
import * as visualCache from '../core/visual-cache.js';
import { formatTable, info, warn, success, fail } from '../output/formatter.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { pageFingerprint, fingerprintBits } from '../cdp/screenshot-hash.js';
import { getActive } from '../core/session-store.js';
import { TirnoError } from '../util/errors.js';
import { judgeFreshness, describeFreshness, formatAge, DEFAULT_STALE_THRESHOLD, type Freshness } from '../core/freshness.js';
import { resolveWaypoints, summarize, type Resolution } from '../cdp/cache-resolve.js';
import * as refStore from '../core/ref-store.js';
import type { RefStore } from '../core/ref-store.js';
import type { Browser } from '../cdp/browser.js';
import type { Page } from '../cdp/page.js';

/** 세션이 그 페이지에 붙어 있을 때만 있는 것 — 비교도 재해결도 이 위에서 한다 */
interface LivePage { browser: Browser; page: Page; sessionName: string }

/**
 * 비교·재해결할 세션을 연다. 세션이 없거나(명시도 active 도 없음) **다른 URL** 에 있으면
 * null 과 이유 — 다른 페이지와 비교한 거리는 "낡았다" 가 아니라 잡음이고, 다른 페이지에서
 * 되찾은 ref 는 엉뚱한 요소다.
 */
async function openLivePage(entry: visualCache.CacheEntry, session?: string): Promise<{ live: LivePage | null; reason?: string }> {
  const sessionName = session ?? getActive() ?? undefined;
  if (!sessionName) return { live: null, reason: 'no session (-s <name>, or attach one)' };
  let browser: Browser;
  try {
    ({ browser } = await connect(sessionName));
  } catch (e) {
    return { live: null, reason: `could not read session '${sessionName}': ${(e as Error).message}` };
  }
  const page = await getActivePage(browser);
  const here = visualCache.parseUrl(page.url());
  const there = visualCache.parseUrl(entry.url);
  if (here.domain !== there.domain || here.urlPath !== there.urlPath) {
    browser.disconnect();
    return { live: null, reason: `session '${sessionName}' is on ${page.url()}, not ${entry.url}` };
  }
  return { live: { browser, page, sessionName } };
}

/** 지금 화면의 지문과 저장값을 대본다 (#188). */
async function compareFreshness(
  entry: visualCache.CacheEntry, live: LivePage | null, reason: string | undefined,
  opts: { compare?: boolean; staleThreshold: number },
): Promise<Freshness> {
  const base = { capturedAt: entry.capturedAt, storedFp: entry.visualFp, threshold: opts.staleThreshold };
  if (opts.compare === false) return judgeFreshness({ ...base, reason: '--no-compare' });
  if (!live) return judgeFreshness({ ...base, reason });
  // 옛 항목의 지문은 9x8 dHash 다 — 정보가 거의 없어 비교해도 뜻이 없다. 다시 찍으라고 한다.
  if (fingerprintBits(entry.visualFp) !== 256) {
    return judgeFreshness({ ...base, reason: 'entry has the old 64-bit fingerprint (near-empty on web pages) — take a fresh `tirno snapshot`' });
  }
  const shot = await live.page.screenshot({ type: 'png', optimizeForSpeed: true }) as Buffer;
  return judgeFreshness({ ...base, currentFp: await pageFingerprint(shot) });
}

/**
 * waypoint 를 지금 페이지에서 되찾아 ref store 를 채운다 (#187). 돌려주는 맵은 출력용 —
 * ref 마다 어느 채널로 찾았는지, 못 찾았으면 왜.
 */
async function resolveIntoRefStore(
  entry: visualCache.CacheEntry, live: LivePage,
): Promise<{ byId: Map<string, Resolution>; summary: ReturnType<typeof summarize> }> {
  const cdp = await live.page.createCDPSession();
  try {
    const resolutions = await resolveWaypoints(cdp, entry.refs);
    const loaderId = await cdp.send('Page.getFrameTree')
      .then(t => (t as unknown as { frameTree: { frame: { loaderId?: string } } }).frameTree.frame.loaderId ?? '')
      .catch(() => '');
    const previous = refStore.load(live.sessionName);
    const refs: RefStore['refs'] = {};
    for (const r of resolutions) {
      if (r.backendId === undefined) continue;
      refs[r.id.replace(/^@/, '')] = { backendId: r.backendId, role: r.role, name: r.name };
    }
    // 세대는 올린다 — 캐시에서 온 ref 라고 #138 의 규율에서 예외가 아니다
    refStore.save(live.sessionName, {
      schemaVersion: refStore.STORE_SCHEMA_VERSION,
      generation: previous.generation + 1,
      url: live.page.url(),
      loaderId,
      capturedAt: new Date().toISOString(),
      refs,
    });
    return { byId: new Map(resolutions.map(r => [r.id, r])), summary: summarize(resolutions) };
  } finally {
    await cdp.detach();
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
    .option('--no-resolve', 'Do not re-find the cached refs on the live page. By default, when a session is on this URL, each ref is resolved (selector → a11y role+name → bbox) and the ref store is filled so `click @N` works right away')
    .option('--require-all', 'Exit 1 when any ref could not be resolved. Off by default: real pages always carry a few unnamed, boxless nodes (a closed <select>\'s popup, spacer rows) that nothing can re-find, and they are listed as UNRESOLVED either way')
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
        // 세션이 그 페이지에 있으면 두 가지를 한다 — 지문을 대보고(#188), ref 를 되찾아
        // store 를 채운다(#187). 없으면 둘 다 안 하고, 안 했다고 적는다.
        const { live, reason } = await openLivePage(entry, opts.session);
        let freshness: Freshness;
        let resolved: Awaited<ReturnType<typeof resolveIntoRefStore>> | null = null;
        try {
          freshness = await compareFreshness(entry, live, reason, opts);
          if (live && opts.resolve !== false) resolved = await resolveIntoRefStore(entry, live);
        } finally {
          live?.browser.disconnect();
        }

        // The text form below puts the selector in brackets, and selectors
        // routinely contain brackets themselves (`input[name="q"]`), so it
        // cannot be parsed back. This is the first step of the value flow and
        // its reader is an agent, so it needs a form that survives a round trip.
        if (opts.json) {
          const resolution = resolved
            ? { summary: resolved.summary.line, refs: [...resolved.byId.values()].map(r => ({ id: r.id, channel: r.channel, note: r.note })) }
            : { summary: `not resolved — ${opts.resolve === false ? '--no-resolve' : reason}` };
          console.log(JSON.stringify({ ...entry, freshness, resolution }, null, 2));
        } else {
          console.log(`# cached at ${entry.capturedAt}`);
          console.log(`# url: ${entry.url}`);
          const vp = entry.viewport ? visualCache.viewportKey(entry.viewport) : '?';
          console.log(`# fp: ${entry.visualFp}  viewport: ${vp}  ${describeFreshness(freshness)}`);
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
            const res = resolved?.byId.get(r.refId ?? r.id);
            const status = !res ? '' : res.channel ? `  ← resolved (${res.note})` : `  ← UNRESOLVED — ${res.note}`;
            console.log(`${id} ${role}${name}${sel}${bbox}${status}`);
          }
          console.log('');
          if (resolved) {
            info(`${resolved.summary.line} — ref store filled; \`tirno click @N\` works on the resolved ones`);
          } else {
            info(`refs not resolved (${opts.resolve === false ? '--no-resolve' : reason}) — \`tirno snapshot\` before clicking`);
          }
        }
        if (freshness.verdict === 'stale' && !opts.allowStale) {
          fail(new TirnoError(
            `cached entry for ${entry.url} is STALE — the page differs by ${freshness.distance}/${freshness.bits} bits (threshold ${freshness.threshold}); take a fresh \`tirno snapshot\`, or --allow-stale to print it anyway`,
            'cache_stale', { distance: freshness.distance, threshold: freshness.threshold, age: freshness.age },
          ));
        }
        if (resolved && resolved.summary.unresolved > 0) {
          const ids = [...resolved.byId.values()].filter(r => !r.channel).map(r => r.id);
          const msg = `${resolved.summary.unresolved} of ${entry.refs.length} cached refs could not be found on the page — marked UNRESOLVED above (${ids.slice(0, 8).join(' ')}${ids.length > 8 ? ' …' : ''}); \`tirno snapshot\` for fresh refs`;
          // 기본은 경고다. 실측(HN 971개)에서 41개가 5px 스페이서 행이었다 — 매번 exit 1 이면
          // 그 신호는 소음이 되고 호출자는 플래그를 상시로 붙인다. 목록과 요약이 이미 시끄럽다.
          if (opts.requireAll) fail(new TirnoError(msg, 'cache_unresolved', { unresolved: ids }));
          if (!opts.json) warn(msg);
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
