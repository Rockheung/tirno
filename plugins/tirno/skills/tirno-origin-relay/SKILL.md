---
name: tirno-origin-relay
description: 진짜 사이트 위에 로컬 빌드를 얹되 서비스워커를 안 쓰는 모드 — host-resolver 를 세션 내내 켜 두고, mounts 에 없는 요청은 진짜 origin 으로 릴레이한다. tirno-sw-override 로는 못 잡는 경우에 쓴다: 앱이 에디터·미리보기 진입 때 스스로 register 하는 "지연 등록 서비스워커"(navigation 마다 update 체크로 배포본으로 갈리는 것), 그리고 로그인 뒤에야 나오는 화면. "지연 등록 SW 가 배포본으로 갈린다", "로그인 뒤 화면을 로컬 빌드로", "sw-override 로 안 되는데 로컬 빌드를 실제 사이트에" 류. 자기 생성기(scripts/generate.mjs)가 serve.mjs·인증서를 낸다 — SW·부트 페이지는 굽지 않는다.
---

# host-resolver + origin-fallback 프록시

**이건 서비스워커가 아니다.** host-resolver 로 크롬의 그 origin 요청을 로컬 서버로 돌리고, 그
서버가 **목록 안은 로컬 빌드, 목록 밖은 진짜 origin 으로 릴레이**하는 fallback 프록시일 뿐이다.
서비스워커는 우리가 심는 게 아니라 **앱이 스스로 등록하는 것**이고, host-resolver 를 상주시키는
이유가 바로 그 앱의 워커에게 계속 로컬 스크립트를 먹이기 위해서다.

[[tirno-sw-override]] 와는 완전히 독립이다 — 자기 생성기·serve 템플릿·인증서를 스스로 갖는다. 성격도 반대다.

| | tirno-sw-override (SW 오버레이) | 이 스킬 (릴레이) |
|---|---|---|
| host-resolver | 부트 후 **뗀다** (진짜 origin 으로) | 세션 내내 **상주** |
| 서비스워커 | 커널 SW 를 심는다 | **안 쓴다** |
| 로컬을 내는 주체 | SW 캐시 | 로컬 서버가 직접 |
| 목록 밖 요청 | **손대지 않는다** (진짜 origin) | 로컬 서버가 진짜 origin 으로 **릴레이** |
| 관측 | 확인 창 · `tirno sw status` | **`serve.log` 뿐** |

## 언제 이 모드인가

**딱 하나를 물어라 — 앱이 자기 서비스워커를 지연 등록하나?**

앱이 에디터·미리보기에 진입할 때 스스로 `register('…/worker.js')` 하는 워커가 있고, 그 워커의
scope 안 문서로 navigation 이 오간다면(미리보기 iframe 이 그렇다), SW 오버레이 방식으론 못 잡는다.
브라우저가 navigation 마다 그 스크립트를 재요청해 진짜 origin 배포본과 비교하고, **쓰는 순간
배포본으로 갈아친다**(spec, update-on-navigation). 선등록으로 미리 심어 둬도 첫 navigation 에
갈린다. 이걸 막는 유일한 길이 host-resolver 상주고, 그러려면 이 모드다.

로그인 뒤에야 나오는 화면(관리자·에디터·대시보드)도 여기다. host-resolver 를 켠 채로 로그인·API
가 살아야 하는데, 그게 릴레이다.

**앱이 자기 SW 를 안 쓴다면** [[tirno-sw-override]] 를 써라 — 손대는 범위가 좁다("목록 밖은
건드리지 않는다").

## 원리

host-resolver 는 **크롬 전용**이다. `--host-resolver-rules="MAP app.example.com 127.0.0.1:PORT"`
는 크롬이 그 origin 에 낼 요청만 로컬 서버로 돌린다. 로컬 `serve.mjs`(node)는 그 규칙에 안
묶여 **OS DNS 로 진짜 origin 에 닿는다** — 그래서 목록 밖 요청을 진짜 origin 으로 릴레이해도
자기 자신으로 순환하지 않는다.

그러면 SW 가 필요 없다. SW 오버레이의 존재 이유가 "host-resolver 를 뗀 진짜 origin 에서도
로컬을 유지" 하는 것인데, host-resolver 를 안 떼면 모든 요청이 이미 로컬 서버로 오므로 서버가
직접 로컬/릴레이를 가른다. 성격이 "SW 오버레이" 가 아니라 **"선택적 로컬 오버라이드가 붙은
필터 릴레이 프록시"** 다.

## 굽기

`generate.mjs` 는 이 스킬 안에 있다(SW 를 안 쓰므로 sw-template·overlay·부트 페이지를 굽지 않는다 — serve.mjs 와 인증서만 낸다). SPA 라면 문서 마운트에 `navigateFallback` 을 준다.

```json
{
  "origin": "https://app.example.com",
  "port": 8443,
  "scope": "/",
  "mounts": [
    { "name": "app-doc", "path": "/app", "file": "./dist/index.html", "navigateFallback": "/app" },
    { "name": "app-assets", "path": "/_/app/", "root": "./dist" }
  ]
}
```

```bash
node scripts/generate.mjs mounts.json --out .relay
```

## 심기 — restart 가 없다

```bash
node .relay/serve.mjs &     # --out .relay 로 구운 것
tirno new preview https://app.example.com/<진입경로> -- \
  --host-resolver-rules="MAP app.example.com 127.0.0.1:8443" --ignore-certificate-errors
# restart 없음 — host-resolver 를 그대로 둔다. 로그인·API 는 릴레이로 살아 있다.
```

SW 오버레이의 "크롬 두 번 뜨고 restart 로 진짜 origin 복귀" 단계가 통째로 없다. host-resolver 를
그대로 두는 것이 이 모드의 핵심이다.

**`--headless` 를 쓰지 마라.** SW 오버레이에서 headless 가 성립한 건 그게 부트스트랩 전용이고
뒤따르는 `restart` 가 창을 띄웠기 때문이다. 이 모드엔 그 restart 가 없어 창이 끝까지 떠 있어야
한다 — 대상이 "로그인 뒤 화면" 인데, 사용자가 그 창에서 직접 로그인할 자리가 필요하다.
그래서 `new` 에 진입 URL 을 바로 주고 headed 로 띄운다.

**`--ephemeral` 도 쓰지 마라** — 앱이 심은 워커·로그인 쿠키가 프로필에 남아야 한다.

**로그인이 자동화(자격증명 주입)라면 clipboard 권한이 걸릴 수 있다.** 새 프로필엔 그 권한이
없어 `navigator.clipboard.readText()` 가 프롬프트를 기다리며 매달린다(실측: 30초 타임아웃).
`tirno permissions grant https://<host> clipboard-read clipboard-write` 로 먼저 준다.

## 무엇이 로컬이고 무엇이 릴레이인가

```
목록 안   /app                       → 로컬              (serve.log "200 /app")
하위경로  /app/library/my (navigate) → 로컬 navigateFallback  ("200 /app/library/my")
하위경로  /app/chunk.js   (자산)      → 진짜 origin 릴레이   ("→ … (relay)")
목록 밖   /_/api/auth/…              → 진짜 origin 릴레이   (로그인·API 가 산다)
```

**SPA 하위 경로는 `navigateFallback` 이 서버에서 잡는다.** 그냥 두면 `/app/library/my` 같은
하위 경로(로그인 리다이렉트가 `back_url` 로 착지하는 자리)가 릴레이로 새서 배포본 문서를 받는다.
`navigateFallback: "/app"` 을 주면 그 접두사 아래 **navigate 요청**(`sec-fetch-mode: navigate`)은
릴레이 대신 로컬 문서를 낸다. 자산 요청은 이 규칙을 안 탄다 — 없는 청크가 `200 text/html` 로
위장되면 더 나쁜 실패가 된다.

## 관측은 serve.log 뿐

확인 창도 `tirno sw status` 도 없다. SW 가 없으니 당연하다 — **등록 목록이 비어도 고장이
아니다.** ("sw status 가 안 보이는데" 는 이 모드에선 정상이다.) 지금 무엇이 로컬로 나가고
무엇이 릴레이되는지는 `serve.log` 가 유일한 창이다:

- `200 <경로>` → 로컬(마운트 또는 navigateFallback)
- `→ <경로> (relay)` → 진짜 origin

## 대가 — 옵트인인 이유

- **"목록 밖은 손대지 않는다" 규율이 깨진다.** 전 트래픽이 로컬 노드 서버를 경유한다.
- `--ignore-certificate-errors` 를 세션 내내 켜 둬야 해서, 그 세션에서 진짜 origin 의 인증서
  검증이 무력화된다.
- 쿠키·리다이렉트·스트리밍 릴레이가 하나라도 어긋나면 "내 빌드 문제인지 프록시 문제인지"
  구분이 안 되는 오진 지점이 생긴다.
- **WebSocket upgrade 는 릴레이하지 않는다.** WS 를 쓰는 앱이면 그 연결이 조용히 끊긴다.

그래서 기본이 아니다. 앱이 자기 SW 를 안 쓰면 [[tirno-sw-override]] 의 커널 방식이 손대는
범위가 좁아 낫다. 이 모드는 지연 등록 워커·로그인 뒤 화면처럼 host-resolver 상주가 꼭
필요한 경우에만 켠다.
