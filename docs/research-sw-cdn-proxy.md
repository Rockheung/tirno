# 배포 전 빌드를 서비스워커로 얹기 — 설계

**문제.** SPA 의 새 빌드를 CDN 에 올리기 전에, **진짜 origin 위에서** 확인하고 싶다.
정적 산출물만 새 것으로 바꾸고 API·인증·쿠키는 그대로 진짜 서버를 쓰는 상태.

**해법.** 서비스워커를 그 origin 에 한 번 심고, 정적 경로만 가로채 새 빌드로 답하게 한다.
심는 동안만 `--host-resolver-rules` 로 그 호스트를 로컬 서버로 돌린다. 심고 나면 rule 을
빼도 SW 는 프로필에 남는다.

> 이 문서는 설계다. 아래 "검증되지 않은 것" 절에 무엇을 아직 안 재봤는지 적어둔다.

---

## 왜 서비스워커인가

resolver rule 만으로도 로컬 빌드를 띄울 수는 있다. 그런데 그건 **호스트 전체**를 로컬로
돌리는 것이라 API 도 같이 끌려온다. 정적만 바꾸고 싶으면 요청 단위로 갈라야 하고,
그 갈림을 브라우저 안에서 하는 물건이 서비스워커다.

| | resolver rule 만 | + 서비스워커 |
|---|---|---|
| 정적 산출물 | 로컬 | 로컬(SW 캐시) |
| API·인증 | **로컬로 끌려옴** | 진짜 origin |
| 크롬을 평소처럼 띄우면 | 원상복귀 | **그대로 유지** |
| 프로필을 남에게 주면 | 안 따라감 | **따라감** |
| TLS | 로컬 인증서 필요 | 부트스트랩 때만 필요 |

## 구성

```
[로컬 빌드 서버]  https://app.example.com  (resolver rule 로 127.0.0.1 에 매핑, 부트스트랩 동안만)
        │  /__tirno-sw.js        SW 스크립트
        │  /manifest.json        이번 빌드가 소유하는 경로 목록
        │  /assets/*             빌드 산출물
        ▼
[크롬 프로필]  ← tirno 가 띄우고 심는다
        │  ServiceWorker 등록 (scope: /)
        │  Cache Storage: tirno-build-<id>
        ▼
[해제 후]  진짜 origin 을 보되, 정적 경로는 SW 가 답한다
```

## 설계 결정

### 1. 부트스트랩 동안에는 **동일 출처**가 된다

이게 이 설계의 핵심 이점이다. resolver rule 이 살아 있는 동안 브라우저에게
`https://app.example.com` 은 로컬 서버다. 따라서 SW 의 `install` 이

```js
await cache.addAll(manifest.assets)   // '/assets/main.abc123.js' — 상대 경로
```

라고만 써도 로컬 서버에서 받아온다. `http://127.0.0.1:PORT` 를 직접 부를 때 따라오는
**CORS · mixed content · Private Network Access 프리플라이트가 전부 사라진다.**

### 2. 무엇을 가로챌지는 **빌드가 정한다**

SW 안에 경로 규칙을 손으로 적으면 낡는다. 빌드가 매니페스트를 내고 SW 는 그것만 본다.

```json
{ "buildId": "2026-08-20-a1b2c3",
  "entry": "/index.html",
  "assets": ["/assets/main.abc123.js", "/assets/style.def456.css"],
  "navigate": true }
```

`fetch` 핸들러의 판정은 셋뿐이다:

1. **내비게이션 요청**(`request.mode === 'navigate'`) → 캐시된 `entry` 로 답한다
2. **매니페스트에 있는 경로** → 캐시에서 답한다
3. **그 외** → `respondWith` 를 부르지 않는다 → 브라우저가 평소대로 진짜 origin 에 간다

`/api/*` 를 막을 규칙을 따로 쓰지 않는다. **목록에 없으면 통과**가 기본값이라 규칙이 하나다.

### 3. 캐시 이름에 빌드 ID 를 박는다

`caches.open('tirno-build-' + BUILD_ID)`. `activate` 에서 접두사가 같고 ID 가 다른 캐시를
지운다. 새 빌드를 얹는 것은 새 SW 스크립트를 등록하는 것과 같은 일이 되고, 옛 산출물은
자동으로 사라진다.

### 4. 스크립트 경로는 origin 이 **안 쓰는 이름**으로

크롬은 내비게이션마다(최대 24시간 간격) SW 스크립트를 다시 받아 갱신을 시도한다.
rule 을 뺀 뒤에는 그 요청이 **진짜 origin** 으로 간다.

- 404 가 돌아오면 → 갱신 실패로 끝나고 **기존 SW 가 그대로 산다** (원하는 결과)
- 그 경로에 **정상 JS 가 있으면** → 우리 SW 가 그것으로 **교체된다**

그래서 `/sw.js` 처럼 흔한 이름을 피하고 `/__tirno-sw.js` 를 쓴다. 스코프는 스크립트가 놓인
디렉터리 기준이므로 루트에 두어야 `/` 전체를 덮는다.

### 5. 프로필을 격리한다

이 SW 는 **그 프로필 안에서 그 origin 을 영구히 바꾼다.** 평소 쓰는 브라우저에 심으면
나중에 원인을 못 찾는다. tirno 세션 하나를 전용으로 쓰고, 되돌릴 때는 `kill --clean` 으로
프로필째 버리는 것이 가장 확실하다.

## 절차

```bash
# ── 부트스트랩 (rule 이 필요한 유일한 구간)
tirno new preview https://app.example.com/ -- \
  --host-resolver-rules="MAP app.example.com 127.0.0.1" \
  --ignore-certificate-errors
# --ephemeral 을 쓰지 않는다. 프로필이 사라지면 SW 도 사라진다

tirno eval "navigator.serviceWorker.register('/__tirno-sw.js').then(r => r.scope)"
tirno eval "navigator.storage.persist()"          # 저장소 축출 위험을 낮춘다
tirno reload                                       # 첫 내비게이션은 SW 가 못 잡는다
tirno eval "navigator.serviceWorker.controller ? 'controlled' : 'NOT controlled'"

# ── rule 을 빼고 재기동. 이제 진짜 origin 을 본다
tirno restart preview
tirno eval "navigator.serviceWorker.controller?.scriptURL"
tirno eval "document.querySelector('meta[name=build]')?.content"   # 새 빌드가 떴나

# ── 되돌리기
tirno kill preview --clean
```

`restart` 는 `--` 뒤 플래그를 다시 받는다. 안 주면 resolver rule 이 빠지고, 프로필은
그대로라 SW 등록과 Cache Storage 는 남는다.

## 서비스워커 (요지)

```js
const BUILD = '__BUILD_ID__';
const CACHE = 'tirno-build-' + BUILD;
let manifest;

self.addEventListener('install', e => e.waitUntil((async () => {
  // rule 이 살아 있는 동안이라 이 상대 경로들은 로컬 서버에서 온다
  manifest = await (await fetch('/manifest.json', {cache: 'no-store'})).json();
  const c = await caches.open(CACHE);
  await c.addAll([manifest.entry, '/manifest.json', ...manifest.assets]);
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) {
    if (k.startsWith('tirno-build-') && k !== CACHE) await caches.delete(k);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;          // 남의 origin 은 안 건드린다

  // 내비게이션 → entry. SPA 라우팅은 어차피 클라이언트가 한다
  if (e.request.mode === 'navigate') {
    e.respondWith(serve(manifest?.entry ?? '/index.html'));
    return;
  }
  // 매니페스트에 있는 것만. 없으면 respondWith 를 안 불러 진짜 origin 으로 나간다
  if (manifest?.assets.includes(url.pathname)) e.respondWith(serve(url.pathname));
});

async function serve(path) {
  const hit = await caches.match(path);
  if (!hit) return fetch(path);
  const h = new Headers(hit.headers);
  h.set('x-served-by', 'tirno-sw/' + BUILD);                // 살아있음을 눈으로 확인
  return new Response(hit.body, {status: 200, headers: h});
}
```

`manifest` 를 모듈 스코프에 두면 SW 가 잠들었다 깰 때 비어 있을 수 있다 — `activate` 나
`fetch` 초입에서 캐시된 `/manifest.json` 으로 다시 채우는 편이 안전하다.

## 한계

- **첫 내비게이션은 SW 가 못 잡는다.** `skipWaiting` + `clients.claim()` 을 넣고 등록 후
  한 번 `reload` 한다.
- **크로스 오리진은 대상이 아니다.** CDN 이 다른 호스트면(`cdn.example.com`) 그 origin 에
  따로 심어야 한다. scope 는 origin 을 넘지 못한다.
- **WebSocket 은 `fetch` 이벤트로 안 온다.**
- **HTTPS 부트스트랩에는 로컬 TLS 가 필요하다.** URL 스킴이 `https` 로 고정이라 IP 만
  바꿔도 크롬은 TLS 핸드셰이크를 건다. 자체 서명 + `--ignore-certificate-errors` 나
  mkcert. 평문 HTTP 서버로는 안 된다.
- **크롬만.** 다른 엔진이 필요하면 별건이다(`docs/research-multi-browser.md`).
- **CSP 가 빡빡하면** 등록 자체는 되지만, 앱이 `worker-src`/`script-src` 를 좁게 걸어둔
  경우 확인이 필요하다.

## tirno 쪽에서 필요한 것

**없다.** 위 절차는 지금 있는 명령만 쓴다 — `new` 의 `--` 패스스루, `eval`, `reload`,
`restart`, `kill --clean`.

한때 `Fetch.requestPaused` 를 받아 로컬 파일로 채워주는 명령이 필요하다고 봤는데,
resolver rule 이 그 자리를 대신하므로 만들지 않는다. tirno 는 부트스트랩 세 줄만 하고 빠진다.

## 실측 (2026-08-20, 실제 사이트에서 완주)

JSON 하나를 바꾸는 최소 형태로 ①~⑤를 끝까지 밟았다. 설계의 미검증 항목이 전부 확인됐다.

| 항목 | 결과 |
|---|---|
| `--host-resolver-rules` 가 포트를 받는가 | **받는다** — `MAP host 127.0.0.1:8443`. 443 이 아니어도 되니 `sudo` 불필요 |
| rule 을 뺀 뒤 SW 가 컨트롤러로 남는가 | **남는다** — `navigator.serviceWorker.controller` 가 `/__tirno-sw.js` |
| origin 이 스크립트 경로에 404 를 줄 때 | **등록이 안 지워진다.** 갱신 시도가 실패하고 기존 SW 가 그대로 산다 |
| 목록 밖 경로가 원본으로 가는가 | **간다** — 같은 origin 의 다른 JS 는 200 이고 `x-served-by` 가 없다 |
| 로그인이 유지되는가 | **안 된다.** `Expires` 없는 세션 쿠키는 브라우저 종료와 함께 사라져, ④의 재기동에서 풀린다. SW 는 남고 로그인은 안 남는다 |

아직 안 재본 것: `install` 에서 매니페스트를 읽어 **여러 파일을 Cache Storage 에 적재**하는
형태. 위 실측은 파일을 캐시에 넣지 않고 SW 소스에 인라인한 최소 형태였다.

절차를 스킬로 뽑아 뒀다 — [`.claude/skills/tirno-sw-override.md`](../.claude/skills/tirno-sw-override.md)
