// tirno sw-proxy — 생성된 파일. 직접 고치지 말고 설정을 고친 뒤 다시 생성한다.
//
// 서비스워커를 커널로 두고, 배포 산출물을 **레이어**로 얹는다.
//
//   resolve("/assets/app.js")
//     1. 레이어 순서대로 — 켜져 있고 그 경로를 가진 첫 레이어가 낸다
//     2. 아무도 안 가지면 respondWith 를 부르지 않는다 → 원본으로 간다
//
// SW 는 **scope 당 하나**이고 scope 는 자산이 아니라 **문서**로 매칭된다. 한 문서는
// 한 SW 에만 제어되므로 앱마다 SW 를 둘 수 없다 — 대신 앱을 레이어로 마운트한다.
// 프로세스를 여럿 띄우는 대신 파일시스템을 마운트하는 쪽이 이 문제의 모양에 맞다.
const CONFIG = __CONFIG__;

// 페이지 안의 확인 창. 이 워커가 직접 내므로, 워커가 없으면 스크립트 태그가 404 를
// 받고 창은 뜨지 않는다 — 창의 존재 자체가 워커 생존의 증거가 되게 하는 구조다.
// 그래서 no-store 다: HTTP 캐시에서 되살아나면 그 증거가 거짓이 된다.
const OVERLAY = __OVERLAY__;
const state = { layers: CONFIG.layers.map(l => ({ ...l, enabled: l.enabled !== false, served: 0 })) };

const cacheName = layer => 'tirno-sw:' + CONFIG.buildId + ':' + layer.id;

self.addEventListener('install', e => e.waitUntil((async () => {
  // 심는 동안에는 이 origin 이 곧 로컬 서버다. 상대 경로가 그리로 가므로
  // CORS·mixed content·Private Network Access 가 걸리지 않는다.
  for (const l of state.layers) {
    const c = await caches.open(cacheName(l));
    // 경로가 겹쳐도 레이어마다 자기 파일을 받아야 한다 — 로컬 서버에 레이어를 밝힌다.
    // 캐시 키는 쿼리 없는 경로라, 나중에 match(pathname) 로 그대로 꺼낸다.
    await Promise.all(l.paths.map(async p => {
      const res = await fetch(p + '?__tirno_layer=' + encodeURIComponent(l.id), { cache: 'no-store' });
      if (!res.ok) throw new Error(`${l.name}: ${p} → ${res.status}`);
      await c.put(p, res);
    }));
  }
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  // 캐시 이름에 buildId 가 들어 있으므로, 접두사가 같고 id 가 다른 것을 지우면
  // 무효화가 끝난다. 버전을 손으로 올릴 일이 없다.
  const mine = new Set(state.layers.map(cacheName));
  for (const k of await caches.keys()) {
    if (k.startsWith('tirno-sw:') && !mine.has(k)) await caches.delete(k);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith(CONFIG.scope + '__tirno/')) {
    return e.respondWith(control(url));
  }

  // 켜져 있는 레이어를 순서대로 — 먼저 가진 쪽이 이긴다.
  const layer = state.layers.find(l => l.enabled && l.paths.includes(url.pathname));
  if (!layer) return;                              // 아무 레이어에도 없음 → 원본으로
  layer.served++;
  e.respondWith(fromLayer(layer, url.pathname, e.request));
});

async function control(url) {
  const op = url.pathname.slice((CONFIG.scope + '__tirno/').length);
  const id = url.searchParams.get('layer');

  if (op === 'status') {
    return json({
      buildId: CONFIG.buildId, origin: self.location.origin, scope: CONFIG.scope,
      generatedAt: CONFIG.generatedAt,
      layers: state.layers.map(l => ({
        id: l.id, name: l.name, mount: l.mount, from: l.from,
        paths: l.paths.length, enabled: l.enabled, served: l.served,
      })),
    });
  }

  if (op === 'overlay.js') {
    return new Response('const __TIRNO_SCOPE__ = ' + JSON.stringify(CONFIG.scope) + ';\n' + OVERLAY, {
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'x-served-by': 'tirno-sw/' + CONFIG.buildId,
      },
    });
  }

  if (op === 'mount' || op === 'unmount') {
    const targets = id ? state.layers.filter(l => l.id === id || l.name === id) : state.layers;
    if (!targets.length) return json({ error: `그런 레이어가 없다: ${id}` }, 404);
    for (const l of targets) l.enabled = (op === 'mount');
    return json({ [op]: targets.map(l => l.name), enabled: state.layers.filter(l => l.enabled).map(l => l.name) });
  }

  if (op === 'off') {
    for (const k of await caches.keys()) if (k.startsWith('tirno-sw:')) await caches.delete(k);
    await self.registration.unregister();
    return json({ off: true, buildId: CONFIG.buildId });
  }

  return json({ error: `모르는 명령: ${op}`, ops: ['status', 'overlay.js', 'mount', 'unmount', 'off'] }, 404);
}

async function fromLayer(layer, pathname, request) {
  const c = await caches.open(cacheName(layer));
  const hit = await c.match(pathname);
  if (!hit) return fetch(request);                 // 캐시가 비었으면 원본이 낫다
  // 헤더를 그대로 넘긴다 — content-type 은 로컬 서버가 붙인 것이 정본이다.
  const h = new Headers(hit.headers);
  h.set('x-served-by', 'tirno-sw/' + CONFIG.buildId);
  h.set('x-tirno-layer', layer.name);
  return new Response(hit.body, { status: 200, headers: h });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-served-by': 'tirno-sw/' + CONFIG.buildId,
    },
  });
}
