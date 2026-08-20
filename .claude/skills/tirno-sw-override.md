---
description: 배포 전 빌드나 임의 응답을 진짜 origin 위에 얹는다. 서비스워커를 그 origin 에 한 번 심어 정적 경로만 가로채고, API·인증은 원본으로 흘린다. 심는 동안만 --host-resolver-rules 로 로컬 서버를 태운다. "이 요청만 다른 걸로 바꿔줘" · "배포 전 빌드를 실제 사이트에서 확인" · "응답 가로채기" 류에 쓴다.
---

# 진짜 origin 위에 응답을 얹기 — 서비스워커 부트스트랩

**언제 쓰나.** 진짜 서버는 살아 있어야 하는데(로그인·API·쿠키가 필요하니까) 정적 응답
일부만 내 것으로 바꾸고 싶을 때.

**왜 다른 방법이 안 되나.**

| 방법 | 왜 안 되나 |
|---|---|
| `tirno eval` 로 `fetch`/`XHR` 패치 | 그 문서에서만 산다. 앱이 **초기화 때 읽는 것**에는 이미 늦고, 리로드하면 패치가 날아간다 |
| `tirno cdp Page.addScriptToEvaluateOnNewDocument` | tirno 는 명령마다 connect/disconnect 한다. 세션이 끊기면 등록도 죽는다 (실측) |
| `--host-resolver-rules` 만 | 호스트 **전체**가 로컬로 끌려온다. API 도 같이 온다 |

서비스워커만 **프로필에 남고**, **요청 단위로** 가른다.

## 절차 (2026-08-20 실측 완주)

`app.example.com` 의 `/path/to/thing.json` 을 바꾼다고 하자.

### 1. 로컬 TLS 서버

부트스트랩 페이지와 SW 스크립트 **둘만** 서빙하면 된다. 사이트 전체를 흉내낼 필요 없다.

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 1 -nodes \
  -subj "/CN=app.example.com" -addext "subjectAltName=DNS:app.example.com"
```

`__tirno-boot.html` 은 빈 페이지면 되고, `__tirno-sw.js` 는 아래 형태다.
python `http.server` 를 `ssl.SSLContext` 로 감싸 **8443** 에 띄운다 (`.js` 의 MIME 을
`application/javascript` 로 등록할 것 — 아니면 등록이 거부된다).

### 2. rule 걸고 재기동

```bash
tirno restart <session> -- \
  --host-resolver-rules="MAP app.example.com 127.0.0.1:8443" \
  --ignore-certificate-errors
tirno nav https://app.example.com/__tirno-boot.html
```

**`MAP host 127.0.0.1:8443` 처럼 포트를 받는다** — 443 이 아니어도 되므로 `sudo` 가 필요 없다.

### 3. 등록

```bash
tirno eval "navigator.serviceWorker.register('/__tirno-sw.js').then(r => r.scope)"
# → scope=https://app.example.com/
```

### 4. rule 빼고 재기동

```bash
tirno restart <session>          # `--` 를 안 주면 플래그가 빠진다
tirno nav https://app.example.com/...
tirno eval "navigator.serviceWorker.controller?.scriptURL"
```

**진짜 origin 이 `/__tirno-sw.js` 에 404 를 줘도 등록은 안 지워진다**(실측). 크롬은
갱신을 시도하다 실패하고 기존 SW 를 그대로 둔다.

### 5. 검증 — 이 셋을 다 본다

```bash
tirno eval 'fetch("/path/to/thing.json").then(r=>r.text())'                    # 내 것이 오나
tirno eval 'fetch("/path/to/thing.json").then(r=>r.headers.get("x-served-by"))' # SW 가 준 게 맞나
tirno eval 'fetch("/other/real.js").then(r=>r.status+" "+(r.headers.get("x-served-by")||"원본"))'
```

세 번째가 중요하다 — **목록에 없는 경로가 진짜로 원본에 가는지**를 봐야 "정적만 바꿨다"가
증명된다.

## 서비스워커

```js
const TARGET  = '/path/to/thing.json';
const PAYLOAD = { /* 바꿔 넣을 것 */ };
self.addEventListener('install',  e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;   // 남의 origin 은 안 건드린다
  if (u.pathname !== TARGET) return;               // 목록 밖 → respondWith 를 안 부른다 → 원본으로
  e.respondWith(new Response(JSON.stringify(PAYLOAD), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-served-by': 'tirno-sw' },
  }));
});
```

**기본값이 통과다.** `/api/*` 를 막을 규칙을 따로 쓰지 않는다 — 목록에 없으면 손대지 않는
것이 곧 통과라 규칙이 하나로 끝난다.

여러 파일을 얹을 거면 `install` 에서 매니페스트를 읽어 `cache.addAll` 한다. **rule 이
살아 있는 동안이라 상대 경로가 로컬 서버로 간다** — CORS·mixed content·Private Network
Access 가 전부 안 걸린다. 이게 이 부트스트랩 방식의 진짜 이점이다.

## 함정

- **스크립트 경로를 origin 이 안 쓰는 이름으로.** 크롬은 내비게이션마다(최대 24시간 간격)
  그 경로를 진짜 origin 에 다시 물어본다. 404 면 기존 SW 가 살지만, **그 경로에 정상 JS 가
  있으면 우리 SW 가 그것으로 교체된다.** `/sw.js` 는 위험하다.
- **스코프는 스크립트가 놓인 디렉터리 기준.** 루트에 둬야 `/` 전체를 덮는다.
- **프로필이 영속이어야 한다.** `--ephemeral` 이면 kill 할 때 SW 도 같이 사라진다.
- **`restart` 는 세션 쿠키를 죽인다.** `Expires` 없는 쿠키는 브라우저 종료와 함께 사라져
  **로그인이 풀린다.** SW 는 남고 로그인은 안 남는다 — 4단계 뒤 다시 로그인해야 할 수 있다.
- **첫 내비게이션은 SW 가 못 잡는다.** `skipWaiting()` + `clients.claim()` 을 넣고 등록 후
  한 번 `reload` 한다.
- **평문 HTTP 서버로는 안 된다.** URL 스킴이 `https` 로 고정이라 IP 만 바꿔도 크롬은 TLS
  핸드셰이크를 건다. 자체 서명 + `--ignore-certificate-errors`, 또는 mkcert.
- **WebSocket 은 `fetch` 이벤트로 안 온다.** 크로스 오리진도 대상이 아니다(scope 는 origin 을
  넘지 못한다).

## 되돌리기

```bash
tirno eval "navigator.serviceWorker.getRegistrations().then(r=>Promise.all(r.map(x=>x.unregister())))"
tirno eval "caches.keys().then(k=>Promise.all(k.map(n=>caches.delete(n))))"
# 확실히 하려면 프로필째 (로그인도 같이 사라진다)
tirno kill <session> --clean
```

**이 SW 는 그 프로필에서 그 origin 을 계속 바꾼다.** 평소 쓰는 브라우저에 심으면 나중에
원인을 못 찾는다. tirno 세션 하나를 전용으로 쓴다.

## 조사할 때 걸리는 것

- **`tirno network` 에 안 보인다고 요청이 없는 게 아니다.** 캡처 창이 `networkidle2` 에서
  닫히므로 그 뒤에 나가는 것은 안 잡힌다.
- **`performance.getEntriesByType('resource')` 는 기본 250개에서 끊긴다.** JS 를 수백 개
  부르는 페이지에서는 진작 넘쳐 있다. `performance.clearResourceTimings()` 후 다시 본다.

설계 전문: [`docs/research-sw-cdn-proxy.md`](../../docs/research-sw-cdn-proxy.md)
