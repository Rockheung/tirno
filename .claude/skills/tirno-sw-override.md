---
description: 진짜 origin 의 특정 경로를 로컬 빌드가 내게 만든다 — 서비스워커를 그 origin 에 한 번 심는 CDN 프록시. 배포 전 빌드를 실제 사이트에서 확인, 스테이징 없이 검증, 로컬 dist 를 실제 도메인으로. 목록에 없는 경로는 손대지 않아 API·인증·쿠키는 진짜 서버로 간다. "배포 안 하고 실제 사이트에서 확인" · "이 파일만 내 빌드로" · "CDN 올리기 전에" 류. **새로고침 후에도 유지돼야 할 때만 쓴다** — 한 번만 보면 되면 tirno eval 로 fetch 를 패치하는 게 훨씬 싸다.
---

# origin 의 응답을 서비스워커가 내게 하기

**하는 일은 하나다.** 지정한 경로들을 로컬 빌드에서 내고, 나머지는 손대지 않는다.

응답을 **수정**하는 것(원본을 받아 필드만 덮기 같은 것)은 여기서 다루지 않는다. 이건 CDN
프록시다 — 파일을 낸다.

## 쓸까 말까

판정선은 하나다. **새로고침 후에도 유지돼야 하나?**

| 상황 | 답 |
|---|---|
| 앱이 **초기화 때** 읽는 파일이다 | **여기** — `eval` 패치는 심는 순간 이미 늦고, 심고 나서 reload 하면 패치가 사라진다 |
| 리로드·재기동을 **넘겨야** 한다 | **여기** |
| 진짜 origin 의 **로그인·API 는 살려야** 한다 | **여기** (`--host-resolver-rules` 만 쓰면 호스트 전체가 끌려와 API 도 온다) |
| 버튼을 눌러야 나가는 요청이다, **한 번만** 보면 된다 | `tirno eval` 로 `fetch` 를 패치한다. 훨씬 싸다 |
| 진짜 origin 의 쿠키·API 가 **필요 없다** | 그냥 `localhost` 를 연다 |

## 절차

### 1. 무엇을 낼지 적는다

```json
{
  "origin": "https://app.example.com",
  "port": 8443,
  "root": "./dist",
  "serve": ["/assets/", "/_/app/index.magnet.json"]
}
```

`serve` 의 항목은 **origin 의 경로**이고 `root` 안에 같은 경로로 있어야 한다.
`/` 로 끝나면 그 아래 전부, 아니면 그 파일 하나. `root` 에 없으면 생성이 실패한다 —
목록과 실물이 어긋난 채로 심는 것보다 낫다.

### 2. 굽는다

```bash
node scripts/sw-proxy/generate.mjs serve.json --out .sw-proxy
```

`__tirno-sw.js` · `__tirno-boot.html` · `serve.mjs` · 인증서가 나오고, 이어서 칠 명령을
찍어 준다. 인증서는 있으면 다시 굽지 않는다.

### 3. 심는다 — 크롬은 두 번 뜨고, 첫 번은 headless 다

```bash
node .sw-proxy/serve.mjs &

tirno new preview --headless -- \
  --host-resolver-rules="MAP app.example.com 127.0.0.1:8443" \
  --ignore-certificate-errors
tirno nav https://app.example.com/__tirno-boot.html
tirno eval "navigator.serviceWorker.register('/__tirno-sw.js').then(r => r.scope)"

tirno restart preview        # rule 없이 — 여기서부터 진짜 origin
```

**`MAP host 127.0.0.1:8443` 처럼 포트를 받는다** — 443 이 아니어도 되니 `sudo` 가 필요 없다.

**`--ephemeral` 을 쓰지 마라.** kill 할 때 프로필이 사라지면 SW 도 같이 사라진다.

부트스트랩 동안에는 그 origin 이 곧 로컬 서버라, SW 의 `install` 이 **상대 경로로**
빌드를 받는다 — `http://127.0.0.1:PORT` 를 직접 부를 때 따라오는 CORS · mixed content ·
Private Network Access 가 전부 안 걸린다. 이게 이 부트스트랩 방식의 이점이다.

### 4. 확인 · 해제

```bash
tirno eval 'fetch("/__tirno/status").then(r => r.text())'
# {"buildId":"76fb0737063c","origin":"…","paths":3,"served":12,…}

tirno eval 'fetch("/__tirno/off").then(r => r.text())'   # unregister + 캐시 삭제
```

`status` 와 `off` 는 **SW 안에** 있다. 로컬 서버가 꺼져 있어도 조회·해제가 된다.

**세 가지를 다 본다.** 하나만 보면 "정적만 바꿨다" 가 증명되지 않는다.

```bash
tirno eval 'fetch("/…내 파일…").then(r => r.headers.get("x-served-by"))'   # tirno-sw/<build>
tirno eval 'fetch("/…목록 밖…").then(r => r.headers.get("x-served-by"))'   # null → 원본
tirno eval 'navigator.serviceWorker.controller?.scriptURL'
```

## 새 빌드를 얹을 때

`generate` 를 다시 돌리고 3단계를 반복한다. `buildId` 는 **경로와 파일 내용의 해시**라,
무엇이든 바뀌면 새 캐시가 생기고 `activate` 가 옛 캐시를 지운다 — 버전을 손으로 올릴 일이 없다.

## 함정

- **스크립트 경로를 origin 이 안 쓰는 이름으로.** 크롬은 내비게이션마다(최대 24시간 간격)
  `/__tirno-sw.js` 를 진짜 origin 에 다시 물어본다. 404 면 갱신 실패로 끝나고 기존 SW 가
  살지만, **그 경로에 정상 JS 가 있으면 우리 SW 가 그것으로 교체된다.** `/sw.js` 는 위험하다.
- **스코프는 스크립트가 놓인 디렉터리 기준.** 루트에 둬야 `/` 전체를 덮는다.
- **`restart` 는 세션 쿠키를 죽인다.** `Expires` 없는 쿠키가 브라우저 종료와 함께 사라져
  **로그인이 풀린다.** SW 는 남고 로그인은 안 남는다 — 3단계 뒤 다시 로그인해야 할 수 있다.
- **첫 내비게이션은 SW 가 못 잡는다.** 템플릿이 `skipWaiting` + `clients.claim()` 을 넣지만,
  등록 직후 한 번 `reload` 하는 편이 확실하다.
- **평문 HTTP 서버로는 안 된다.** URL 스킴이 `https` 로 고정이라 IP 만 바꿔도 크롬은 TLS
  핸드셰이크를 건다. 생성기가 자체 서명 인증서를 굽고 `--ignore-certificate-errors` 로 넘긴다.
- **크로스 오리진은 대상이 아니다.** CDN 이 다른 호스트면 그 origin 에 따로 심는다 —
  scope 는 origin 을 넘지 못한다. **WebSocket 도 `fetch` 이벤트로 안 온다.**
- **이 SW 는 그 프로필에서 그 origin 을 계속 바꾼다.** 평소 쓰는 브라우저에 심으면 나중에
  원인을 못 찾는다. tirno 세션 하나를 전용으로 쓰고, 확실히 되돌리려면
  `tirno kill <세션> --clean` 으로 프로필째 버린다(로그인도 같이 사라진다).

## 인증서 — `mkcert -install` 은 이 절차에 없다

인증서는 생성기가 `openssl` 로 굽는다. `mkcert` 로 구워도 된다 — 굽는 도구는 상관없다.

**하지 않는 것은 `mkcert -install` 이다.** mkcert 안내문이 으레 함께 시키지만, 이 절차에는
필요 없다. 신뢰는 `--ignore-certificate-errors` 로 **그 크롬 세션에만** 국한한다 — tirno 가
띄운 그 프로세스 하나에만 걸리고, 죽으면 같이 사라진다.

`-install` 은 로컬 CA 를 시스템 신뢰 저장소에 넣는 일이다. 부트스트랩 몇 초를 편하려고
치르기엔 범위가 너무 넓다. 다른 사유로 CA 를 설치해 두는 것은 각자의 판단이고 이 스킬이
관여할 바 아니지만, **이 절차 때문에 설치할 이유는 없다.**

## 조사할 때 걸리는 것

- **`tirno network` 에 안 보인다고 요청이 없는 게 아니다.** 캡처 창이 `networkidle2` 에서
  닫히므로 그 뒤에 나가는 것은 안 잡힌다.
- **`performance.getEntriesByType('resource')` 는 기본 250개에서 끊긴다.** JS 를 수백 개
  부르는 페이지에서는 진작 넘쳐 있다. `performance.clearResourceTimings()` 후 다시 본다.

설계 전문: [`docs/research-sw-cdn-proxy.md`](../../docs/research-sw-cdn-proxy.md)
