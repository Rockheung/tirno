// tirno sw-proxy — 생성된 파일. 직접 고치지 말고 설정을 고친 뒤 다시 생성한다.
//
// 하는 일은 하나다: 목록에 있는 경로를 로컬 빌드에서 낸다.
// 목록에 없으면 respondWith 를 부르지 않고, 그것이 곧 원본으로 통과다 —
// 그래서 API·인증을 막을 규칙을 따로 쓰지 않는다.
//
// SW 는 origin 당 하나가 아니라 **scope 당 하나**이고, scope 는 자산이 아니라
// **문서**로 매칭된다. 문서가 이 SW 에 제어되면 그 문서의 모든 요청이 여기 온다 —
// 경로가 scope 밖이어도 온다. 그래서 앱마다 SW 를 두는 것은 불가능하고,
// 하나가 여러 앱을 나눠 낸다. 어느 앱이 냈는지는 x-tirno-app 으로 구분한다.
const CONFIG = __CONFIG__;
const CACHE = 'tirno-sw:' + CONFIG.buildId;
const OWNER = CONFIG.paths;                       // 경로 → 앱 이름
const served = {};                                // 앱별 응답 수

self.addEventListener('install', e => e.waitUntil((async () => {
  // 심는 동안에는 이 origin 이 곧 로컬 서버다. 상대 경로가 그리로 가므로
  // CORS·mixed content·Private Network Access 가 걸리지 않는다.
  const c = await caches.open(CACHE);
  await c.addAll(Object.keys(OWNER));
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

  if (url.pathname === CONFIG.scope + '__tirno/status') {
    return e.respondWith(json({
      buildId: CONFIG.buildId, origin: self.location.origin, scope: CONFIG.scope,
      generatedAt: CONFIG.generatedAt,
      apps: CONFIG.apps.map(a => ({
        name: a.name, mount: a.path, from: a.from,
        paths: a.paths, served: served[a.name] ?? 0,
      })),
    }));
  }
  if (url.pathname === CONFIG.scope + '__tirno/off') {
    return e.respondWith((async () => {
      for (const k of await caches.keys()) if (k.startsWith('tirno-sw:')) await caches.delete(k);
      await self.registration.unregister();
      return json({ off: true, buildId: CONFIG.buildId });
    })());
  }

  const app = OWNER[url.pathname];
  if (!app) return;                                // 목록에 없음 → 원본으로
  served[app] = (served[app] ?? 0) + 1;
  e.respondWith(fromCache(url.pathname, app, e.request));
});

async function fromCache(pathname, app, request) {
  const hit = await caches.match(pathname);
  if (!hit) return fetch(request);                 // 캐시가 비었으면 원본이 낫다
  // 헤더를 그대로 넘긴다 — content-type 은 로컬 서버가 붙인 것이 정본이다.
  const h = new Headers(hit.headers);
  h.set('x-served-by', 'tirno-sw/' + CONFIG.buildId);
  h.set('x-tirno-app', app);
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
