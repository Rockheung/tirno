import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// `sw status` 의 판정은 **워커가 헤더를 찍는다**는 전제 위에 서 있다 (#132). 그런데 그
// 전제를 검사하는 것이 아무것도 없었다 — sw-template 에서 Server-Timing 한 줄을 지워도
// decideServedBy 의 테스트는 전부 통과하고, status 만 조용히 옛 오판으로 돌아간다.
// 그것은 이 이슈가 고치려던 결함과 정확히 같은 종류다.
//
// 그래서 텍스트를 grep 하는 대신 **워커를 실제로 돌린다.** Chrome 은 안 띄운다 —
// 서비스워커는 결국 이벤트 핸들러를 등록하는 스크립트이고, caches 와 self 만 흉내내면
// 그 핸들러가 무엇을 내는지 여기서 그대로 볼 수 있다.

const TEMPLATE = path.join(
  import.meta.dirname, '..', '..',
  'plugins/tirno/skills/tirno-sw-override/scripts/sw-template.js',
);

const ORIGIN = 'https://imtest.me';
const BUILD = 'testbuild123';

const CONFIG = {
  buildId: BUILD,
  origin: ORIGIN,
  scope: '/',
  generatedAt: '2026-08-24T00:00:00.000Z',
  layers: [{
    id: 'l1',
    name: 'app',
    mount: '/widget-studio',
    from: './dist',
    paths: ['/widget-studio', '/assets/index-Ly1_L1hy.js'],
    navigateFallback: '/widget-studio',
  }],
};

type Handler = (event: SwEvent) => void;
interface SwEvent {
  request?: { url: string; mode?: string };
  respondWith(r: Promise<Response> | Response): void;
  waitUntil(p: Promise<unknown>): void;
}

/** Cache Storage 흉내. 바이트로 들고 있다가 꺼낼 때마다 새 Response 를 만든다 —
 *  실제 Cache Storage 도 그렇고, 안 그러면 본문을 두 번 못 읽는다. */
function makeCaches() {
  const store = new Map<string, Map<string, { body: Buffer; headers: Record<string, string> }>>();
  return {
    store,
    async open(name: string) {
      if (!store.has(name)) store.set(name, new Map());
      const c = store.get(name)!;
      return {
        async put(key: string, res: Response) {
          const body = Buffer.from(await res.arrayBuffer());
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => { headers[k] = v; });
          c.set(key, { body, headers });
        },
        async match(key: string) {
          const hit = c.get(key);
          return hit ? new Response(new Uint8Array(hit.body), { headers: hit.headers }) : undefined;
        },
        async keys() {
          return [...c.keys()].map(k => ({ url: ORIGIN + k }));
        },
      };
    },
    async keys() { return [...store.keys()]; },
    async delete(name: string) { return store.delete(name); },
  };
}

interface Worker {
  handlers: Map<string, Handler>;
  caches: ReturnType<typeof makeCaches>;
}

/** 템플릿을 치환해 실행하고, 등록된 핸들러를 돌려준다. */
function loadWorker(fetchImpl: (input: unknown) => Promise<Response>): Worker {
  const src = fs.readFileSync(TEMPLATE, 'utf-8')
    .replace('__CONFIG__', JSON.stringify(CONFIG))
    .replace('__OVERLAY__', JSON.stringify('/* overlay */'));

  const handlers = new Map<string, Handler>();
  const cachesImpl = makeCaches();
  const self = {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
    location: { origin: ORIGIN },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: { unregister: async () => true },
  };

  const run = new Function('self', 'caches', 'fetch', 'Response', 'Headers', 'URL', src);
  run(self, cachesImpl, fetchImpl, Response, Headers, URL);
  return { handlers, caches: cachesImpl };
}

async function installed(): Promise<Worker> {
  const worker = loadWorker(async (input) => {
    const url = String(input);
    return new Response(`built:${url}`, { headers: { 'content-type': 'text/html' } });
  });
  const waits: Promise<unknown>[] = [];
  worker.handlers.get('install')!({
    respondWith() {},
    waitUntil: p => waits.push(p),
  });
  await Promise.all(waits);
  return worker;
}

/** fetch 핸들러를 부르고, respondWith 로 넘어온 응답을 돌려준다. */
async function request(worker: Worker, url: string, mode: string): Promise<Response | null> {
  let answered: Promise<Response> | Response | null = null;
  worker.handlers.get('fetch')!({
    request: { url, mode },
    respondWith: r => { answered = r; },
    waitUntil() {},
  });
  return answered === null ? null : await answered;
}

test('the worker caches every declared path at install', async () => {
  const worker = await installed();
  const cache = [...worker.caches.store.values()][0]!;
  assert.deepEqual([...cache.keys()].sort(), ['/assets/index-Ly1_L1hy.js', '/widget-studio']);
});

// #132 의 핵심. 이 헤더가 없으면 `sw status` 는 navigateFallback 이 덮은 문서를
// 다시 origin 으로 오판한다 — 재fetch 는 non-navigate 라 이 자리를 못 탄다.
test('a served document carries Server-Timing, and that is what status reads', async () => {
  const worker = await installed();
  const res = await request(worker, `${ORIGIN}/widget-studio`, 'navigate');
  assert.ok(res, 'the worker must answer a mounted path');
  assert.equal(res.headers.get('server-timing'), `tirno-sw;desc="${BUILD}"`);
  assert.equal(res.headers.get('x-served-by'), `tirno-sw/${BUILD}`);
  assert.equal(res.headers.get('x-tirno-layer'), 'app');
});

// 이슈에 적힌 바로 그 흐름: 로그인 리다이렉트가 하위 경로로 착지한다.
test('a navigateFallback subpath is served, and stamped the same way', async () => {
  const worker = await installed();
  const res = await request(worker, `${ORIGIN}/widget-studio/library/my`, 'navigate');
  assert.ok(res, 'navigate under the fallback prefix must be answered');
  assert.equal(res.headers.get('server-timing'), `tirno-sw;desc="${BUILD}"`);
  assert.equal(await res.text(), 'built:/widget-studio?__tirno_layer=l1');
});

// 이것이 오판의 원인이었다 — 같은 경로라도 non-navigate 면 워커가 응답하지 않는다.
// 그래서 재fetch 로는 판정할 수 없고, 그래서 Server-Timing 이 필요하다.
test('the same subpath as a non-navigate request is NOT answered', async () => {
  const worker = await installed();
  assert.equal(await request(worker, `${ORIGIN}/widget-studio/library/my`, 'cors'), null);
});

test('a path nobody mounted falls through to the origin', async () => {
  const worker = await installed();
  assert.equal(await request(worker, `${ORIGIN}/somewhere/else`, 'navigate'), null);
});

// `sw status` 는 stamps 의 부재를 "옛 빌드" 로 읽고 판정을 unknown 으로 떨어뜨린다.
// 그 신호를 워커가 실제로 내보내는지 확인한다.
test('the control endpoint declares stamps:true and the fallback prefix', async () => {
  const worker = await installed();
  const res = await request(worker, `${ORIGIN}/__tirno/status`, 'cors');
  assert.ok(res);
  const body = await res.json() as {
    buildId: string; stamps: boolean;
    layers: Array<{ name: string; navigateFallback?: string; paths: number }>;
  };
  assert.equal(body.buildId, BUILD);
  assert.equal(body.stamps, true, 'without this, status cannot treat a missing stamp as proof of origin');
  assert.equal(body.layers[0]!.navigateFallback, '/widget-studio');
  assert.equal(body.layers[0]!.paths, 2);
});

test('a disabled layer stops serving, and says so at the control endpoint', async () => {
  const worker = await installed();
  await request(worker, `${ORIGIN}/__tirno/unmount?layer=l1`, 'cors');
  assert.equal(await request(worker, `${ORIGIN}/widget-studio`, 'navigate'), null);

  const status = await request(worker, `${ORIGIN}/__tirno/status`, 'cors');
  const body = await status!.json() as { layers: Array<{ enabled: boolean }> };
  assert.equal(body.layers[0]!.enabled, false);
});

test('another origin is never touched', async () => {
  const worker = await installed();
  assert.equal(await request(worker, 'https://elsewhere.example/widget-studio', 'navigate'), null);
});
