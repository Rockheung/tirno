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
  /**
   * 이 빌드는 자기가 낸 응답에 `Server-Timing: tirno-sw` 를 반드시 찍는다.
   * 그래서 **스탬프가 없다는 것이 원본이라는 증거**가 된다. 이 키가 없는 옛 빌드에서는
   * 그 추론이 성립하지 않으므로 판정이 `unknown` 으로 떨어진다 (#132).
   */
  stamps?: boolean;
  layers?: Array<{
    name?: string; mount?: string; enabled?: boolean; served?: number; paths?: number;
    /** 이 접두사 아래의 navigate 요청은 목록에 없어도 이 레이어의 문서가 낸다. */
    navigateFallback?: string;
  }>;
}

/**
 * 이 문서를 오버레이가 냈나, 원본이 냈나 — 그리고 그것을 무엇으로 알았나.
 *
 * `overlay` 와 `origin` 사이에 `unknown` 이 있다. 예전에는 없었고, 그래서
 * **navigateFallback 이 덮은 하위 경로 문서가 origin 으로 오판됐다** (#132).
 * 판정을 재fetch 로 했는데 그 재fetch 는 non-navigate 라, `request.mode === 'navigate'`
 * 에만 응답하는 fallback 을 못 타고 헤더가 안 붙었기 때문이다. 로그인 리다이렉트가
 * 하위 경로로 착지하는 흐름에서 흔히 걸린다.
 *
 * 모르는 것을 origin 이라고 말하는 것이 오판의 형태였으므로, 모르면 모른다고 한다.
 */
type Verdict = 'overlay' | 'origin' | 'unknown';

interface ServedBy {
  verdict: Verdict;
  /** 표시용 이름 — 오버레이면 `tirno-sw/<buildId>`. */
  by: string | null;
  layer: string | null;
  /** 무엇을 보고 그렇게 판정했나. 출력에 그대로 싣는다. */
  evidence: string;
}

interface SwReport {
  url: string;
  registrations: Registration[];
  caches: CacheEntry[];
  control: ControlStatus[];
  served: ServedBy;
}

/**
 * 페이지에서 걷어오는 **사실**. 판정은 여기 없다 — `decideServedBy` 가 노드 쪽에서
 * 한다. 판정을 페이지 안에 두면 브라우저를 띄우지 않고는 검증할 수 없고, 이 판정은
 * 한 번 틀렸던 자리다 (#132).
 */
export interface ServedEvidence {
  pathname: string;
  /** navigation timing 에 실린 `Server-Timing: tirno-sw` 의 desc (= buildId). */
  stamp: string | null;
  /** 문서 URL 재fetch 의 `x-served-by` — non-navigate 라, 없다고 원본인 것은 아니다. */
  refetchServedBy: string | null;
  refetchLayer: string | null;
  cachedPaths: string[];
  control: ControlStatus[];
  hasRegistration: boolean;
}

/** `/app` 은 `/app` 과 `/app/…` 을 덮고 `/application` 은 덮지 않는다 — sw-template 과 같은 규칙. */
function underPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  return pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
}

/**
 * 이 문서를 오버레이가 냈나.
 *
 * 예전에는 재fetch 의 `x-served-by` 하나로 판정했고, 그 재fetch 는 non-navigate 였다.
 * navigateFallback 은 `request.mode === 'navigate'` 인 요청에만 응답하므로, **fallback 이
 * 덮은 하위 경로 문서는 헤더가 없어 origin 으로 오판됐다** (#132). 로그인 리다이렉트가
 * 하위 경로로 착지하는 흐름에서 흔히 걸린다.
 *
 * 근거를 센 것부터 쌓는다:
 *
 * 1. **Server-Timing** — 재fetch 가 아니라 이 문서가 실제로 받은 그 응답. 확정.
 * 2. **재fetch 헤더** — 있으면 확정. 없는 것은 아무것도 확정하지 않는다.
 * 3. 그 다음은 "오버레이가 냈을 수 있나" 를 **배제**할 수 있을 때만 origin 이라고 한다.
 *    배제하지 못하면 `unknown` 이다 — 모르는 것을 origin 이라고 말하는 것이 오판의
 *    형태였다.
 */
export function decideServedBy(e: ServedEvidence): ServedBy {
  if (!e.hasRegistration) {
    return { verdict: 'origin', by: null, layer: null, evidence: 'no service worker is registered for this origin' };
  }
  if (e.stamp) {
    return {
      verdict: 'overlay',
      by: `tirno-sw/${e.stamp}`,
      layer: e.refetchLayer,
      evidence: 'Server-Timing on this document’s own response',
    };
  }
  if (e.refetchServedBy) {
    return {
      verdict: 'overlay',
      by: e.refetchServedBy,
      layer: e.refetchLayer,
      evidence: 're-fetch of the document URL',
    };
  }
  if (e.control.length === 0) {
    // tirno sw-proxy 가 아닌 워커다. 오버레이라는 개념 자체가 없다.
    return { verdict: 'origin', by: null, layer: null, evidence: 'no tirno sw-proxy controls this document' };
  }
  if (e.control.every(c => c.stamps === true)) {
    // 이 빌드는 자기가 낸 문서에 반드시 스탬프를 찍는다. 없다 = 이 빌드가 낸 것이 아니다.
    return { verdict: 'origin', by: null, layer: null, evidence: 'this sw-proxy build stamps Server-Timing; this document carries none' };
  }
  if (e.cachedPaths.includes(e.pathname)) {
    // 정확경로로 캐시에 있었다면 non-navigate 재fetch 로도 잡혔어야 한다.
    return { verdict: 'origin', by: null, layer: null, evidence: 're-fetch, and this exact path is in Cache Storage' };
  }
  const declared = e.control.flatMap(c =>
    (c.layers ?? []).filter(l => l.enabled !== false && l.navigateFallback).map(l => l.navigateFallback!));
  if (declared.length > 0 && !declared.some(prefix => underPrefix(e.pathname, prefix))) {
    // 이 워커가 자기 fallback 접두사를 밝혔고, 그중 어느 것도 이 경로를 안 덮는다.
    return { verdict: 'origin', by: null, layer: null, evidence: 'no declared navigateFallback prefix covers this path' };
  }
  return {
    verdict: 'unknown',
    by: null,
    layer: null,
    evidence: 'older sw-proxy build: a non-navigate re-fetch cannot see a navigateFallback response',
  };
}

async function collect(page: Awaited<ReturnType<typeof getActivePage>>): Promise<SwReport> {
  const raw = await page.evaluate(async () => {
    const out = {
      url: location.origin + location.pathname,
      pathname: location.pathname,
      registrations: [] as Registration[],
      caches: [] as CacheEntry[],
      control: [] as ControlStatus[],
      stamp: null as string | null,
      refetchServedBy: null as string | null,
      refetchLayer: null as string | null,
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

    if ('caches' in self) {
      for (const name of await caches.keys()) {
        const c = await caches.open(name);
        const reqs = await c.keys();
        out.caches.push({ name, paths: reqs.map(q => new URL(q.url).pathname).sort() });
      }
    }

    // 이 문서가 실제로 받은 응답. 문서 응답의 헤더는 JS 로 못 읽지만 Server-Timing 은
    // navigation timing 엔트리에 그대로 실린다(same-origin) — 재fetch 가 필요 없다.
    const nav = performance.getEntriesByType('navigation')[0] as
      (PerformanceEntry & { serverTiming?: ReadonlyArray<{ name: string; description: string }> }) | undefined;
    out.stamp = nav?.serverTiming?.find(t => t.name === 'tirno-sw')?.description ?? null;

    // 스탬프를 안 찍는 옛 워커를 위한 2차 근거. non-navigate 라 **없다고 원본인 것은 아니다.**
    if (!out.stamp && out.registrations.length > 0) {
      try {
        const res = await fetch(location.href, { cache: 'no-store' });
        out.refetchServedBy = res.headers.get('x-served-by');
        out.refetchLayer = res.headers.get('x-tirno-layer');
      } catch { /* 못 받아도 판정이 unknown 으로 떨어질 뿐이다 */ }
    }

    return out;
  });

  return {
    url: raw.url,
    registrations: raw.registrations,
    caches: raw.caches,
    control: raw.control,
    served: decideServedBy({
      pathname: raw.pathname,
      stamp: raw.stamp,
      refetchServedBy: raw.refetchServedBy,
      refetchLayer: raw.refetchLayer,
      cachedPaths: raw.caches.flatMap(c => c.paths),
      control: raw.control,
      hasRegistration: raw.registrations.length > 0,
    }),
  };
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
    const { verdict, by, layer, evidence } = report.served;
    const served =
      verdict === 'overlay' ? `${by}${layer ? `  (layer ${layer})` : ''}  ← 오버레이`
      : verdict === 'origin' ? 'origin (원본 — 오버레이가 이 문서를 내지 않았다)'
      : 'unknown (판정 불가 — 아래)';
    console.log(`
Current document: ${report.url}`);
    console.log(`Served by       : ${served}`);
    console.log(`Evidence        : ${evidence}`);
    if (verdict === 'unknown') {
      // 모르는 것을 origin 이라고 말하던 자리다 (#132). 무엇을 더 보면 알 수 있는지까지 적는다.
      info('  이 문서는 navigate 로 로드됐는데 그 경로가 Cache Storage 에 없다 — navigateFallback 이');
      info('  덮었을 수 있고, non-navigate 재fetch 로는 그것이 안 보인다. 로드된 엔트리로 확인해라:');
      info(`    tirno eval '[...document.scripts].map(s => s.src)'`);
      info('  워커를 다시 생성하면(sw-override generate) Server-Timing 이 붙어 이 자리가 확정된다.');
    }
  }

  for (const c of report.control) {
    console.log(`\nsw-proxy control @ ${c.scope}${c.buildId ? ` (build ${c.buildId})` : ''}`);
    const layers = c.layers ?? [];
    if (layers.length === 0) {
      info('  no layers reported');
      continue;
    }
    // NAVIGATE 는 "목록에 없는 하위 경로도 이 레이어가 낸다" 는 뜻이다. 이것이 안 보이면
    // Served by 가 왜 unknown 인지 읽을 수 없다 (#132).
    console.log(formatTable(['LAYER', 'MOUNT', 'NAVIGATE', 'ENABLED', 'FETCHED', 'PATHS'], layers.map(l => [
      l.name ?? '-',
      l.mount ?? '-',
      l.navigateFallback ? `${l.navigateFallback}/*` : '-',
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
