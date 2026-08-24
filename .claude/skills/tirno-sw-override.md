---
name: tirno-sw-override
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

## 필요조건

이 스킬은 **빌드하지 않고, 무엇을 얹을지 정하지 않는다.** 둘 다 호출자가 준다.

### 호출자가 갖춰야 할 것

| | |
|---|---|
| `origin` | **https** URL. 실재하고 도달 가능해야 한다 (로그인 여부는 무관) |
| `mounts` | origin 경로 ← 로컬 빌드. **이미 빌드돼 있어야 한다** — 이 스킬은 빌드를 돌리지 않는다 |
| 경로 선정 | **origin 이 그 경로를 실제로 쓰는지는 호출자가 안다** — 이 스킬은 모른다. 가리키는 곳이 없으면 생성이 실패한다 |
| `scope` | **볼 문서가 사는 곳.** 자산 경로가 아니다. 그 아래 문서를 열어야 SW 가 붙는다 — 아니면 아무 일도 안 일어난다 |
| 레이어 이름 | 겹치면 생성이 실패한다. `x-tirno-layer` 와 status·mount/unmount 의 키가 된다 |
| 레이어 **순서** | 경로가 겹치면 **먼저 선언한 것이 이긴다.** 로컬 작업본을 배포본 위에 얹으려면 위에 적는다 — 이건 오류가 아니라 이 스킬이 기대하는 쓰임이다 |

### 환경

- `openssl` 이 PATH 에 (인증서를 굽는다)
- Node 22+ · `tirno` 실행 가능
- 지정 포트(기본 8443)가 비어 있을 것
- **macOS/리눅스.** 키체인·`security` 에 의존하지는 않지만 `openssl` 과 셸을 쓴다

### 세션 상태

- **영속 프로필.** `--ephemeral` 이면 kill 할 때 SW 도 사라진다
- **크롬 재기동 1회를 감당할 수 있을 것.** `Expires` 없는 세션 쿠키는 재기동에 죽지만,
  `tirno restart --keep-cookies` 가 세션 쿠키까지 넘겨 준다 — 로그인을 먼저 해 둬도 된다

### 끝나고 나면 (호출자가 이어받는 상태)

| | |
|---|---|
| 프로필 | 그 origin 이 **계속** 바뀐 채로 남는다. tirno 없이 열어도 그렇다 |
| `buildId` | scope·레이어·경로·파일 내용의 해시. 무엇이든 바뀌면 새 id 가 나오고 옛 캐시는 `activate` 가 지운다 |
| 조회 | 페이지 안에서는 **확인 창**(아래), 밖에서는 `tirno sw status` |
| 확인 창 | 마운트된 HTML 에 실리는 플로팅 창. 가장자리에 붙고 드래그되며, 열면 레이어 → 경로가 트리로 나온다. **창이 있다 = 워커가 이 문서를 내주고 있다** |
| 해제 | `GET <scope>__tirno/off` → unregister + 캐시 삭제. **로컬 서버 없이도 된다** |
| 레이어 구분 | 모든 응답에 `x-tirno-layer: <이름>` |
| 레이어 제어 | `<scope>__tirno/mount\|unmount?layer=<이름>` — 런타임, 재부트스트랩 없이. 생략하면 전부 |
| 로그인 | `--keep-cookies` 로 재기동했으면 그대로, 아니면 풀려 있다 |

### 엮이는 자리

- **앞** — 빌드를 돌리는 쪽, 그리고 origin 의 어느 경로를 덮을지 아는 쪽.
  그 둘이 `mounts` 를 만든다
- **뒤** — 로그인이 필요하면 그때 한다. 조작·검증은 `tirno-runbook` 의 흐름을 탄다
- **되돌리기** — `<scope>__tirno/off` 로 이 스킬의 효과만 걷거나,
  `tirno kill <세션> --clean` 으로 프로필째 버린다(로그인도 같이 사라진다)

## 절차

### 1. 무엇을 낼지 적는다

```json
{
  "origin": "https://app.example.com",
  "port": 8443,
  "scope": "/admin/",
  "mounts": [
    { "name": "local-override", "path": "/_/magnet/", "root": "../magnet/dist" },
    { "name": "deployment-123", "path": "/_/magnet/", "root": "../artifacts/123" },
    { "name": "modal",          "path": "/_/publish-modal/", "root": "../modal/dist" },
    { "name": "vendor-patch",   "path": "/vendor/v.js", "file": "./patched/v.js" }
  ]
}
```

### 레이어 — 위에 있는 것이 이긴다

마운트는 **레이어**다. 경로가 겹치면 오류가 아니라 우선순위다 — 먼저 선언된 쪽이 낸다.
위 예에서 `/_/magnet/` 은 로컬 작업본이 배포 산출물을 덮고 있고, 로컬을 내리면 배포본이
드러난다.

```
resolve("/_/magnet/assets/app.js")
  1. local-override   ← 켜져 있고 그 경로를 가짐 → 낸다
  2. deployment-123
  3. (아무도 없으면) 원본
```

**런타임에 올리고 내린다.** 다시 굽거나 다시 심을 필요가 없다.

```bash
tirno eval 'fetch("/admin/__tirno/unmount?layer=local-override").then(r => r.text())'
tirno eval 'fetch("/admin/__tirno/mount?layer=local-override").then(r => r.text())'
tirno eval 'fetch("/admin/__tirno/mount").then(r => r.text())'      # layer 생략 = 전부
```

### 확인 창 — 있다는 것 자체가 신호다

마운트된 HTML 에 `<script src="<scope>__tirno/overlay.js" defer>` 한 줄이 실린다. 그 스크립트를
내는 것은 워커 자신이고 `no-store` 다. 그래서:

- 워커가 없으면 태그가 404 를 받고 **아무 일도 일어나지 않는다**
- HTML 에 태그가 있다는 것 자체가 그 문서를 워커 캐시에서 받았다는 뜻이다
- 뜬 뒤에 워커가 죽으면 창이 스스로 사라진다 — 컨트롤러·워커 상태·**등록** 세 가지를 본다.
  `unregister()` 는 이벤트를 주지 않고 이미 제어 중인 문서를 계속 제어하므로(실측),
  등록은 2초마다 `getRegistration()` 으로 확인한다. fetch 가 아니라 유휴 워커를 깨우지 않는다

즉 창의 유무가 워커 생존의 지표다. 이 성질을 깨지 않으려면 창을 다른 데서 주입하지 않는다.

**문서를 마운트하지 않는 구성에서는 창이 뜨지 않는다.** 원본 응답을 고쳐서까지 띄우지는
않기 때문이다 — 배포 전 빌드를 실제 사이트에서 보는 판에 문서를 변형하면 확인 대상 자체가
오염된다. 그런 구성은 페이지 밖에서 `tirno sw status` 로 본다.

끄려면 설정에 `"overlay": false`.

보기 전용이다. 레이어를 켜고 끄는 것은 아래의 `mount`/`unmount` 가 한다.

### SPA — 하위 경로로 직접 들어올 때

진입점 하나를 문서로 마운트해도, 그 앱의 하위 경로로 **직접 진입하거나 거기서 새로고침하면**
원본이 뜬다. SW 는 마운트한 경로만 정확히 매칭하기 때문이다. 라우트에 동적 세그먼트가 있으면
덮어야 할 경로가 무한이라 나열로는 원리적으로 커버할 수 없다.

파일 마운트에 `navigateFallback` 을 켜면, 그 접두사 아래의 **navigate 요청**이 어느 경로에도
안 맞을 때 그 문서를 낸다.

```json
{ "name": "app-doc", "path": "/app", "file": "./dist/index.html", "navigateFallback": "/app" }
```

- **기본값 off.** 목록에 없으면 원본이 이 도구의 규율이고, 이것은 부르는 쪽이 켜는 예외다
- **navigate 요청에만** 적용한다. 자산까지 이렇게 하면 없는 청크가 `200 text/html` 로 위장되어
  훨씬 나쁜 실패가 된다(실측: `/app/nonexistent-chunk.js` 는 404 로 남는다)
- 접두사는 경계까지 본다 — `/app` 은 `/app` 과 `/app/…` 을 덮고 `/application` 은 덮지 않는다
- 파일 마운트 전용이다. 디렉터리 마운트에 주면 생성이 실패한다 — 어느 문서를 낼지 정해지지 않는다
- `unmount` 하면 fallback 도 함께 꺼진다

### 앱마다 SW 를 둘 수는 없다

**scope 는 자산이 아니라 문서로 매칭된다.** 문서가 어느 SW 에 제어되는지가 먼저 정해지고,
그 문서에서 나가는 요청은 **경로와 무관하게** 그 SW 로만 간다. 실측:

| | |
|---|---|
| `/a/` scope SW, 문서 `/` 에서 `fetch('/a/x.js')` | **안 잡힌다.** 그 문서는 컨트롤러가 없다 |
| `/admin/` scope SW, 문서 `/admin/…` 에서 `fetch('/_/app/x.js')` | **잡힌다.** scope 밖 경로여도 온다 |

그래서 `/_/a-app/` ← a-sw, `/_/b-app/` ← b-sw 같은 구성은 **등록은 되지만 한 번도 안 불린다**
— 요청을 보내는 문서가 그 scope 아래에 없기 때문이다. 앱이 자기 iframe 을 갖고 그 문서가
그 경로 아래 있는 경우가 아니라면 성립하지 않는다.

**`scope` 는 볼 화면이 사는 곳으로 잡는다.** 관리자만 볼 거면 `/admin/` 이면 되고, 그러면
사이트의 나머지에는 SW 가 아예 안 붙는다. 기본값은 `/` 다.

**앱은 레이어 이름으로 구분한다** — 응답의 `x-tirno-layer` 헤더, `<scope>__tirno/status` 의
레이어별 집계, 생성 시 출력. `name` 을 안 주면 경로에서 만든다.

`path` 가 `/` 로 끝나면 `root` 디렉터리 전부를 그 접두사 아래로, 아니면 `file` 하나를
그 경로에. **origin 의 경로와 로컬 경로는 달라도 된다** — 앱의 `dist/` 는 자기 루트가
`/` 지만 origin 에서는 `/_/app/` 아래 사는 것이 보통이고, 그 어긋남을 마운트가 흡수한다.

가리키는 곳이 없거나 마운트가 겹치면 생성이 실패한다 — 어느 빌드가 이길지 모호한 채로
심는 것보다 낫다.

### 2. 굽는다

```bash
node <스킬>/scripts/generate.mjs mounts.json --out .sw-proxy
```

생성기는 이 스킬 옆에 있다. 플러그인으로 설치했으면 그 설치 경로의
`skills/tirno-sw-override/scripts/generate.mjs`, tirno 레포에서 직접이면
`plugins/tirno/skills/tirno-sw-override/scripts/generate.mjs` 다.

`__tirno-sw.js` · `__tirno-boot.html` · `serve.mjs` · 인증서가 나오고, 이어서 칠 명령을
찍어 준다. 인증서는 있으면 다시 굽지 않는다.

### 3. 심는다 — 크롬은 두 번 뜨고, 첫 번은 headless 다

```bash
node .sw-proxy/serve.mjs &

tirno new preview --headless -- \
  --host-resolver-rules="MAP app.example.com 127.0.0.1:8443" \
  --ignore-certificate-errors
tirno nav https://app.example.com/admin/__tirno-boot.html
tirno eval "navigator.serviceWorker.register('/admin/__tirno-sw.js').then(r => r.scope)"

tirno restart preview --keep-cookies   # rule 없이 — 여기서부터 진짜 origin. 로그인은 넘어온다
```

**`MAP host 127.0.0.1:8443` 처럼 포트를 받는다** — 443 이 아니어도 되니 `sudo` 가 필요 없다.

**`--ephemeral` 을 쓰지 마라.** kill 할 때 프로필이 사라지면 SW 도 같이 사라진다.

부트스트랩 동안에는 그 origin 이 곧 로컬 서버라, SW 의 `install` 이 **상대 경로로**
빌드를 받는다 — `http://127.0.0.1:PORT` 를 직접 부를 때 따라오는 CORS · mixed content ·
Private Network Access 가 전부 안 걸린다. 이게 이 부트스트랩 방식의 이점이다.

### 앱 자신의 SW 도 개발 버전으로 (선택)

앱이 **이미 자기 서비스워커를 쓰는 경우**, 그 SW 도 로컬 개발 버전으로 심을 수 있다 —
sw-proxy 커널과 **공존**한다(다른 scope). 실측으로 확인했다.

**핵심**: SW 스크립트 요청은 다른 SW 의 `fetch` 를 우회하지만(순환 방지, spec) **네트워크는
우회하지 않는다.** register 하는 그 순간 `/app-sw.js` 가 실제로 나가니, 부트스트랩 중
(host-resolver 로 로컬 서빙)에 register 하면 로컬 버전이 프로필에 박힌다. 이후 진짜 origin 으로
돌아가도 SW 는 등록 때 받은 스크립트를 저장해 두므로 재요청 없이 유지된다.

그러니 sw-proxy 를 **못 쓰는** 대상이 아니라, 같은 부트스트랩에 한 줄 더 얹는 것이다:

```bash
# 굽기: mounts 에 앱 SW 스크립트를 파일 마운트로 추가
{ "name": "app-sw", "path": "/app-sw.js", "file": "./app/dist/sw.js" }

# 3번 심기 단계에서, 커널과 함께 앱 SW 도 register (로컬 서빙 중)
tirno eval "Promise.all([
  navigator.serviceWorker.register('/admin/__tirno-sw.js'),
  navigator.serviceWorker.register('/app-sw.js', { scope: '/app-scope/' })
]).then(() => 'both')"

tirno restart preview --keep-cookies   # 진짜 origin — 둘 다 넘어온다
```

실측 검증(진짜 origin, host-resolver 뗀 뒤):

```
getRegistrations → [{scope:/, __tirno-sw.js, activated}, {scope:/app-scope/, app-sw.js, activated}]
앱 SW 에 postMessage → "appsw:LOCAL-DEV"   ← 로컬 개발 버전이 돌고 있다
```

**scope 는 앱이 쓰는 그대로 맞춘다.** 앱 코드가 특정 scope 로 등록한다면 같은 scope 로 먼저
등록해 선점하거나, 앱 문서를 로드해 앱이 스스로 등록하게 두되 그 스크립트 요청만 로컬이 받게 한다.

**한계 — update 체크.** 브라우저는 24h·navigation 마다 SW 스크립트를 다시 받아 비교한다. 그때는
진짜 origin 의 `/app-sw.js`(원본)와 대조되므로, 오래 두면 개발 버전이 원본으로 갈릴 수 있다
(sw-proxy 커널도 같은 리스크). 짧은 QA 세션엔 문제없고, 길게는 그 URL 을 계속 로컬로 두거나
update 를 막는다.

### 4. 확인 · 해제

```bash
tirno eval 'fetch("/admin/__tirno/status").then(r => r.text())'
# {"buildId":"76fb0737063c","origin":"…","paths":3,"served":12,…}

tirno eval 'fetch("/admin/__tirno/off").then(r => r.text())'   # unregister + 캐시 삭제
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
- **`restart` 는 세션 쿠키를 죽인다 — `--keep-cookies` 를 주지 않으면.** `Expires` 없는 쿠키가
  브라우저 종료와 함께 사라져 SW 는 남고 로그인은 안 남는다. `--keep-cookies` 는 재기동 전에
  쿠키를 받아 두었다가 다시 심는다(`httpOnly`·`secure`·`sameSite`·세션 여부까지 그대로).
  쿠키를 못 받아 오면 재기동하지 않는다 — 못 챙긴 채 진행하면 되돌릴 수 없다.
- **첫 내비게이션은 SW 가 못 잡는다.** 템플릿이 `skipWaiting` + `clients.claim()` 을 넣지만,
  등록 직후 한 번 `reload` 하는 편이 확실하다.
- **평문 HTTP 서버로는 안 된다.** URL 스킴이 `https` 로 고정이라 IP 만 바꿔도 크롬은 TLS
  핸드셰이크를 건다. 생성기가 자체 서명 인증서를 굽고 `--ignore-certificate-errors` 로 넘긴다.
- **크로스 오리진은 대상이 아니다.** CDN 이 다른 호스트면 그 origin 에 따로 심는다 —
  scope 는 origin 을 넘지 못한다. **WebSocket 도 `fetch` 이벤트로 안 온다.**
- **이 SW 는 그 프로필에서 그 origin 을 계속 바꾼다.** 평소 쓰는 브라우저에 심으면 나중에
  원인을 못 찾는다. tirno 세션 하나를 전용으로 쓰고, 확실히 되돌리려면
  `tirno kill <세션> --clean` 으로 프로필째 버린다(로그인도 같이 사라진다).

## 인증서

생성기가 `openssl` 로 굽는다. `mkcert` 로 구워도 된다.

**`mkcert -install` 은 하지 않는다.** 신뢰는 `--ignore-certificate-errors` 로 그 크롬
세션에만 국한한다 — tirno 가 띄운 그 프로세스 하나에만 걸리고, 죽으면 같이 사라진다.

## 계보

뜬금없는 발명이 아니다. 검증된 세 조각의 조합이다.

| | |
|---|---|
| [Wayne](https://github.com/jcubic/wayne) | "Express inside Service Worker". SW 를 브라우저 안의 HTTP 서버로 쓰고, VFS·커스텀 핸들러·네트워크 폴백으로 응답을 고른다 |
| [CodeSandbox `static-browser-server`](https://github.com/codesandbox/static-browser-server) | 가상 파일을 SW 로 서빙하는 브라우저 내부 정적 서버 |
| [MSW](https://github.com/mswjs/msw) | 앱 코드를 안 건드리고 네트워크 층에서 가로채되, 안 걸리는 요청은 실제 네트워크로 통과 — 이 문서의 "목록에 없으면 respondWith 를 안 부른다" 가 같은 규율이다 |

이 스킬이 다른 점은 서빙 대상이 **가상 프로젝트가 아니라 아직 배포되지 않은 산출물**이고,
얹는 곳이 **살아 있는 production 페이지**라는 것이다. 그래서 mock 보다는 **deployment
overlay** 라고 부르는 편이 정확하다 — 페이지를 프리뷰용으로 다시 빌드하지 않고, URL 도
production 그대로다.

레이어 모델도 여기서 왔다. 앱마다 SW 를 띄우려는 충동이 자연스럽지만 그건 불가능하고,
**SW 하나를 커널로 두고 배포본을 마운트/언마운트**하는 편이 이 문제의 모양에 맞다.

## 조사할 때 걸리는 것

- **`tirno network` 에 안 보인다고 요청이 없는 게 아니다.** 캡처 창이 `networkidle2` 에서
  닫히므로 그 뒤에 나가는 것은 안 잡힌다.
- **`performance.getEntriesByType('resource')` 는 기본 250개에서 끊긴다.** JS 를 수백 개
  부르는 페이지에서는 진작 넘쳐 있다. `performance.clearResourceTimings()` 후 다시 본다.

설계 전문: [`docs/research-sw-cdn-proxy.md`](../../docs/research-sw-cdn-proxy.md)
