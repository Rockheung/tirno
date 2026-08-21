// tirno sw-proxy — 생성된 파일. 직접 고치지 말고 규칙 파일을 고친 뒤 다시 생성한다.
//
// 하는 일은 하나다: 목록에 있는 경로를 로컬 빌드에서 낸다.
// 목록에 없으면 respondWith 를 부르지 않고, 그것이 곧 원본으로 통과다 —
// 그래서 API·인증을 막을 규칙을 따로 쓰지 않는다.
const CONFIG = __CONFIG__;
const CACHE = 'tirno-sw:' + CONFIG.buildId;
const EXACT = new Set(CONFIG.paths);
let served = 0;

self.addEventListener('install', e => e.waitUntil((async () => {
  // 심는 동안에는 이 origin 이 곧 로컬 서버다. 상대 경로가 그리로 가므로
  // CORS·mixed content·Private Network Access 가 걸리지 않는다.
  const c = await caches.open(CACHE);
  await c.addAll(CONFIG.paths);
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  // 캐시 이름에 buildId 가 들어 있으므로, 접두사가 같고 id 가 다른 것을 지우면
  // 무효화가 끝난다. 버전을 손으로 올릴 일이 없다.
  for (const k of await caches.keys()) {
    if (k.startsWith('tirno-sw:') && k !== CACHE) await caches.delete(k);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/__tirno/status') {
    return e.respondWith(json({
      buildId: CONFIG.buildId, origin: self.location.origin,
      paths: CONFIG.paths.length, served, generatedAt: CONFIG.generatedAt,
    }));
  }
  if (url.pathname === '/__tirno/off') {
    return e.respondWith((async () => {
      for (const k of await caches.keys()) if (k.startsWith('tirno-sw:')) await caches.delete(k);
      await self.registration.unregister();
      return json({ off: true, buildId: CONFIG.buildId });
    })());
  }

  if (!EXACT.has(url.pathname)) return;      // 목록에 없음 → 원본으로
  served++;
  e.respondWith(fromCache(url.pathname, e.request));
});

async function fromCache(pathname, request) {
  const hit = await caches.match(pathname);
  if (!hit) return fetch(request);           // 캐시가 비었으면 원본이 낫다
  const h = new Headers(hit.headers);
  h.set('x-served-by', 'tirno-sw/' + CONFIG.buildId);
  return new Response(hit.body, { status: 200, headers: h });
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-served-by': 'tirno-sw/' + CONFIG.buildId,
    },
  });
}
