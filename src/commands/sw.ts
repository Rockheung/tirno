import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { formatTable, info, error } from '../output/formatter.js';

/**
 * What a service worker is actually proxying, read from the browser rather than
 * from whatever generated it.
 *
 * The obvious source is the sw-proxy's own `<scope>__tirno/status`, and it is
 * not enough: a worker outlives the local server that served its script, and a
 * profile can carry one this CLI never generated. Measured on a live session —
 * script 404 at the origin, control endpoint answering with the site's HTML,
 * caches named by a scheme the current template does not produce, and the 22
 * proxied paths still sitting in Cache Storage and still being served.
 *
 * So registrations and Cache Storage are the source of truth here, and the
 * control endpoint is an optional overlay for the workers that do answer it.
 */

interface Registration {
  scope: string;
  scriptURL: string | null;
  state: string | null;
  controlsThisDocument: boolean;
}

interface CacheEntry {
  name: string;
  paths: string[];
}

interface ControlStatus {
  scope: string;
  buildId?: string;
  layers?: Array<{ name?: string; mount?: string; enabled?: boolean; served?: number; paths?: number }>;
}

interface SwReport {
  url: string;
  registrations: Registration[];
  caches: CacheEntry[];
  control: ControlStatus[];
  servedBy: string | null;   // 현재 문서 응답의 x-served-by (오버레이면 tirno-sw/…, 원본이면 null)
  servedLayer: string | null;
}

async function collect(page: Awaited<ReturnType<typeof getActivePage>>): Promise<SwReport> {
  return await page.evaluate(async () => {
    const out = {
      url: location.origin + location.pathname,
      registrations: [] as Registration[],
      caches: [] as CacheEntry[],
      control: [] as ControlStatus[],
      servedBy: null as string | null,
      servedLayer: null as string | null,
    };

    if ('serviceWorker' in navigator) {
      const controller = navigator.serviceWorker.controller;
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        const worker = r.active ?? r.waiting ?? r.installing;
        out.registrations.push({
          scope: r.scope,
          scriptURL: worker ? worker.scriptURL : null,
          state: worker ? worker.state : null,
          controlsThisDocument: !!controller && !!worker && controller.scriptURL === worker.scriptURL,
        });

        // Optional overlay. A worker that is not an sw-proxy answers with the
        // site's own 404 page, so the content-type decides — not the status.
        try {
          const scopePath = new URL(r.scope).pathname;
          const res = await fetch(scopePath + '__tirno/status', { cache: 'no-store' });
          if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
            const body = await res.json();
            out.control.push({ ...body, scope: r.scope });
          }
        } catch { /* no control endpoint — the common case */ }
      }
    }

    // 이 문서가 오버레이에서 왔나 원본에서 왔나. SW 는 자기가 낸 응답에만
    // x-served-by/x-tirno-layer 를 붙이므로(sw-template fromLayer), 문서 URL 을
    // 다시 받아 헤더를 본다. navigateFallback 없이 하위 경로로 착지하면 SW 가
    // 컨트롤해도 문서는 원본이라 이 헤더가 없다 — CONTROLS=yes 만으로는 못 가른다.
    try {
      const res = await fetch(location.href, { cache: 'no-store' });
      out.servedBy = res.headers.get('x-served-by');
      out.servedLayer = res.headers.get('x-tirno-layer');
    } catch { /* 못 받아도 판정만 빈다 */ }

    if ('caches' in self) {
      for (const name of await caches.keys()) {
        const c = await caches.open(name);
        const reqs = await c.keys();
        out.caches.push({ name, paths: reqs.map(q => new URL(q.url).pathname).sort() });
      }
    }

    return out;
  }) as SwReport;
}

function render(report: SwReport, showPaths: boolean): void {
  console.log(`URL: ${report.url}`);

  if (report.registrations.length === 0) {
    info('No service worker registered for this origin.');
  } else {
    console.log('\nService workers');
    console.log(formatTable(['SCOPE', 'SCRIPT', 'STATE', 'CONTROLS'], report.registrations.map(r => [
      r.scope,
      r.scriptURL ?? '-',
      r.state ?? '-',
      r.controlsThisDocument ? 'yes' : 'no',
    ])));

    // 이 문서가 실제로 오버레이 빌드냐 원본이냐 — CONTROLS=yes 여도 원본일 수 있다.
    const served = report.servedBy
      ? `${report.servedBy}${report.servedLayer ? `  (layer ${report.servedLayer})` : ''}  ← 오버레이`
      : 'origin (원본 — 오버레이가 이 문서를 내지 않았다)';
    console.log(`
Current document: ${report.url}`);
    console.log(`Served by       : ${served}`);
  }

  for (const c of report.control) {
    console.log(`\nsw-proxy control @ ${c.scope}${c.buildId ? ` (build ${c.buildId})` : ''}`);
    const layers = c.layers ?? [];
    if (layers.length === 0) {
      info('  no layers reported');
      continue;
    }
    console.log(formatTable(['LAYER', 'MOUNT', 'ENABLED', 'FETCHED', 'PATHS'], layers.map(l => [
      l.name ?? '-',
      l.mount ?? '-',
      l.enabled === false ? 'no' : 'yes',
      String(l.served ?? '-'),
      String(l.paths ?? '-'),
    ])));
    // FETCHED 는 이번 SW 인스턴스가 fetch 로 처리한 횟수라, 캐시 히트나 bfcache 로
    // 로드되면 0 이다(재기동 직후 흔하다). "덮였나" 는 PATHS(Cache Storage 적재분)로 본다.
    info('  FETCHED = 이번 SW 인스턴스의 fetch 처리 횟수 (캐시 히트는 0). 덮임 여부는 PATHS 로 본다.');
  }

  if (report.caches.length === 0) {
    console.log('');
    info('No cache storage for this origin — nothing is being served from a cache.');
    return;
  }

  console.log('\nProxied resources (Cache Storage)');
  console.log(formatTable(['CACHE', 'PATHS'], report.caches.map(c => [c.name, String(c.paths.length)])));

  if (!showPaths) {
    const total = report.caches.reduce((n, c) => n + c.paths.length, 0);
    console.log('');
    info(`${total} path(s) total — pass --paths to list them.`);
    return;
  }
  for (const c of report.caches) {
    console.log(`\n${c.name}`);
    for (const p of c.paths) console.log(`  ${p}`);
  }
}

export function registerSwCommands(program: Command): void {
  const sw = program
    .command('sw')
    .description('Service workers on the active page — what a CDN proxy is registered for and which resources it serves');

  sw
    .command('status')
    .description('Registered workers, the resources they serve from Cache Storage, and sw-proxy layers when the worker answers its control endpoint')
    .option('-s, --session <name>', 'Session name')
    .option('--paths', 'List every cached path instead of the count')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const report = await collect(page);
        browser.disconnect();

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        render(report, !!opts.paths);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
