# 온보딩 — 설치부터 첫 세션까지

이 문서의 숫자는 전부 `main` 을 **새로 클론해 실행한 값**이다. 설치·빌드·첫 세션·유닛·스모크를
그대로 밟았다.

명령 표면의 정본은 `tirno schema` 다 — `--help` 는 사람용 산문이라 옵션이 116개 엔드포인트에
흩어져 있다.

---

## 먼저 확인할 것 — Chrome 하나

| | |
|---|---|
| **Chrome** | 아래 순서로 찾는다 |

1. `--executable-path`
2. 환경변수 `TIRNO_CHROME` → `CHROME_PATH` → `PUPPETEER_EXECUTABLE_PATH`
3. `tirno chrome set` 로 적어 둔 경로(`~/.tirno/config.json`)
4. 후보 목록 — 첫 후보는 `tirno setup` 이 받는 `~/.tirno/chrome/` 의 Chrome for Testing

macOS:

```
~/.tirno/chrome/chrome-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
~/.agent-browser/browsers/chrome-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
/Applications/Chromium.app/Contents/MacOS/Chromium
~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium
~/.cache/puppeteer/chrome/*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
```

Linux:

```
~/.tirno/chrome/*/chrome-linux*/chrome
/usr/bin/google-chrome
/usr/bin/google-chrome-stable
/usr/bin/chromium
/usr/bin/chromium-browser
/snap/bin/chromium
/usr/lib/chromium/chromium
~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome
~/.cache/puppeteer/chrome/*/chrome-linux*/chrome
```

어디서 찾았는지와 실패 이유는 `tirno chrome show` / `tirno setup --check` 가 보여 준다. 쓸
브라우저가 없으면 `tirno setup` 이 `~/.tirno` 로 받아 온다(`-y` 는 묻지 않고, `--force` 는 있어도
받는다). 못 찾으면 기동이 `Chrome not found` 로 멈춘다. Brave·Edge·다른 경로에 깔린 Chrome 은
`--executable-path` 로 직접 주거나 `tirno chrome set` 으로 한 번 적어 둔다. `--executable-path`
값은 세션 메타에 남아 `restart` 에서도 유지된다.

Chrome 말고 `--browser firefox`(Firefox, `$TIRNO_FIREFOX`)와 `--browser safari`(Safari
Technology Preview 의 safaridriver, `$TIRNO_SAFARI`)도 된다. 되는 명령은 nav · eval · screenshot ·
snapshot · click · fill · type · press · wait-for · pages · new-tab · select · close-tab · ls · restart · kill 이고, Safari 는 세션 하나에
headless 가 없다. 세 엔진 모두 신뢰되지 않은 https 인증서를 받는다.

Node 는 **바이너리로 받으면 필요 없다** — 런타임이 들어 있다. 소스에서 빌드할 때만
Node 22+ 가 필요하다.

> **npm 레지스트리에 없다.** `npm i -g tirno` 는 안 된다.

---

## 설치 — 받아서 바로

```bash
mkdir -p ~/.local/bin
curl -fsSL https://github.com/Rockheung/tirno/releases/latest/download/tirno-bun-darwin-arm64 -o ~/.local/bin/tirno
chmod +x ~/.local/bin/tirno
tirno --version
```

`tirno: command not found` 면 `~/.local/bin` 이 `PATH` 에 없는 것이다:

```bash
export PATH="$HOME/.local/bin:$PATH"     # 셸 설정에도 넣어둔다
```

**sudo 를 쓰는 자리가 없다.** 도구는 `~/.local/bin`, 브라우저는 `tirno setup` 이 받아
`~/.tirno/chrome/` 에 둔다. 시스템 경로가 편하면 `sudo mv ~/.local/bin/tirno /usr/local/bin/`
로 옮기면 되지만, 그것은 선택이지 전제가 아니다.

타깃 넷 — `darwin-arm64` · `darwin-x64` · `linux-x64` · `linux-arm64`.
자기 것으로 파일명만 바꾼다. **Windows 는 대상이 아니다**(소유권 판정이 `lsof`·`ps` 를 읽는다).

검증까지 하려면 **받고 → 확인하고 → 설치**한다. 순서가 반대면 확인이 늦고, 설치한 것을
다시 그 이름으로 복사해 두는 군더더기가 생긴다:

```bash
curl -fsSLO https://github.com/Rockheung/tirno/releases/latest/download/tirno-bun-darwin-arm64
curl -fsSLO https://github.com/Rockheung/tirno/releases/latest/download/SHA256SUMS
shasum -a 256 -c SHA256SUMS 2>/dev/null | grep darwin-arm64     # → OK  (리눅스는 sha256sum)

mkdir -p ~/.local/bin
mv tirno-bun-darwin-arm64 ~/.local/bin/tirno && chmod +x ~/.local/bin/tirno
```

여기까지가 끝이다. **아래는 도구를 고칠 사람만** 본다.

---

## 소스에서 — 고칠 사람만

### 1. 클론

```bash
git clone https://github.com/Rockheung/tirno.git
cd tirno
```

### 2. 의존성

```bash
npm install
```

`node_modules` 가 **222MB** 된다. 대부분 `lighthouse`(21MB)와 그것이 끌고 오는
`@opentelemetry`(49MB)이고, `tirno audit` 하나가 쓴다.

### 3. 빌드 — 안 하면 아무것도 안 돈다

```bash
npm run build     # tsc → dist/
```

`bin/tirno.js` 는 `dist/` 를 부른다. TypeScript 를 고쳤으면 매번 다시 빌드하거나
`npm run dev`(`tsc --watch`)를 띄워 둔다.

### 4. PATH 에 올리기 (선택)

```bash
npm link
```

이러면 어디서든 `tirno` 로 부른다. 안 하려면 `node /path/to/tirno/bin/tirno.js …` 를 그대로 쓴다.

### 5. 확인

```bash
$ tirno --version
0.11.0

$ tirno schema | jq '.commands | length'
116
```

`tirno schema` 는 **기계가 읽는 명령 목록**이다. 명령마다 `effects` 와 `destructive` 가 붙어
있어, 실행 전에 무엇이 지워지는지 알 수 있다.

---

## 첫 5분

세션을 하나 띄우고, 페이지를 읽고, 지운다.

```
$ tirno new demo https://example.com --headless
✓ Session 'demo' created (port 63481, PID 53892, url: https://example.com)

$ tirno ls
   │ NAME │ ENGINE │ PORT  │ STATUS  │ OWNER │ PROXY  │ EMULATION    │ POLICY │ LAST ACCESS
───┼──────┼────────┼───────┼─────────┼───────┼────────┼──────────────┼────────┼─────────────────────
 * │ demo │ chrome │ 63481 │ running │ ours  │ direct │ 1920x1080@1x │ -      │ 2026-11-08 11:35:31

$ tirno snapshot
@1  RootWebArea "Example Domain"
@2    paragraph
@3      StaticText "This domain is for use in documentation examples without needing permission. …"

$ tirno screenshot
✓ ~/.tirno/tmp/screenshot-<시각>.png (1920x1080)

$ tirno kill demo --clean
✓ Killed 'demo' (PID 53892, profile cleaned)
```

세션 하나 띄우는 데 **0.89초**. `--headless` 를 빼면 창이 실제로 뜬다.

`-s <name>` 을 안 주면 **active 세션**(`ls` 의 `*`)에 붙는다. `-s` 는 **하위 명령 뒤에** 온다:

```bash
tirno eval "1+1" -s demo      # ✓
tirno -s demo eval "1+1"      # ✗ error: unknown option '-s'
```

---

## 덜 헤매려면 알아둘 넷

### 1. `@ref` 는 세션마다·페이지마다 다시 찍는다

`snapshot` 이 만든 `@12` 는 그 세션의 `~/.tirno/refs/<name>.json` 에 `backendDOMNodeId` 로
저장된다. **번호가 같아도 매핑은 세션마다 따로**고, 페이지가 바뀌면 무효가 된다.

```
✗ that element is no longer in the document — the page re-rendered and replaced it. Run "tirno snapshot" and use the new ref
```

이 메시지가 뜨면 `snapshot` 을 다시 찍는다. 여러 세션이면 `tirno broadcast snapshot` 으로
한꺼번에.

### 2. 소유권 — tirno 는 장부를 믿지 않는다

pid 가 살아 있고 · 그 pid 가 그 포트를 듣고 있고 · 그 프로세스의 `--user-data-dir` 이 맞아야
`ours` 다. 셋 중 하나라도 어긋나면 `foreign`/`ambiguous` 로 보고 **붙지도, 죽이지도 않는다**.

```
✗ Refusing to connect to session '<name>' (port <port>): pid <pid> is gone;
  port <port> now belongs to <다른 프로세스> (pid <pid>)
```

포트를 남이 물려받은 상황이다. 장부만 걷으려면 `tirno gc` — 브라우저를 죽이지 않고 프로필도
안 지운다.

### 3. 뷰포트는 1920x1080 으로 고정된다

스크린샷 재현성과 visual cache 의 viewport 키 정합성 때문이다. 바꾸려면
`tirno emulate --viewport 800x600`, 또는 `new` 뒤에 `-- --window-size=…`.

### 4. 여러 대는 `broadcast`, 범위는 `--group`

```bash
tirno new w1 --group wall
tirno new w2 --group wall
tirno broadcast nav https://example.com --group wall
```

세션들에 **동시에** 나간다. 출력은 완료 순이 아니라 세션 목록 순으로 모아 찍어서 파이프로
넘길 수 있고, 자식 하나라도 실패하면 `broadcast` 도 실패한다.

---

## 데이터는 어디에 쌓이나

전부 `~/.tirno/` 아래다. `TIRNO_DIR` 하나로 **통째로** 옮겨진다 — 테스트와 스모크가 실제 홈과
격리되는 수단이 이것이다.

| 환경변수 | 기본값 | 용도 |
|---|---|---|
| `TIRNO_DIR` | `~/.tirno` | 데이터 루트 전체 |
| `TIRNO_CACHE_DIR` | `<루트>/visual-cache` | snapshot 캐시 |
| `TIRNO_RECORDINGS_DIR` | `<루트>/recordings` | `record` 산출물 |
| `TIRNO_TRAILS_DIR` | `<루트>/trails` | 사용자 시연 기록 |
| `TIRNO_METRICS_FILE` | `<루트>/metrics.jsonl` | `stats` 가 읽는 로그 |
| `TIRNO_METRICS` | (없음) | `0` 이면 메트릭 기록 끔 |

`~/.tirno/profiles/<name>/` 은 **로그인된 브라우저 세션**이다. 이걸 지우는 것은 `kill --clean` ·
`gc --older-than` · ephemeral 세션의 자동 정리(`kill`/`restart`/`new --force`)뿐이다.
`tirno schema` 의 `destructive` 표시를 보면 실행 전에 가려낼 수 있다.

`~/.tirno/models/` 가 있다면 지워도 된다 — 지금 코드는 참조하지 않는다.

---

## 고칠 사람에게

| 명령 | 무엇을 증명하나 | 실측 |
|---|---|---|
| `npm test` | 파서·판정 로직. **Chrome 을 안 띄운다** — 캡처한 문자열로 돈다(Safari 실세션 테스트는 `TIRNO_TEST_SAFARI=1` 일 때만) | 582건(통과 581 · 건너뜀 1) · 9.4s |
| `node scripts/smoke.mjs` | 명령이 **실제로 도는가**. 종료코드만이 아니라 출력·파일·페이지 상태까지 재독한다 | 449건 · 약 150s |
| `npm run lint` | eslint | — |

**둘 다 PR 게이트다** — `ci.yml` 이 유닛과 스모크를 같이 돌리고, 하나라도 깨지면 PR 이 빨간불이 된다.
(`gate-regression.yml` 은 Chrome 의 관측된 행동이 여전한지 보는 별건이고, 수동 트리거다.)

스모크는 크롬을 실제로 띄우고 네트워크를 쓴다(`audit` 이 http(s) 만 받는다). `TIRNO_DIR` 을
임시 디렉터리로 격리하므로 당신의 `~/.tirno` 는 건드리지 않는다 — 그걸 검사 자체로 못 박아 뒀다.

### 어디를 고치나

- `src/commands/` — 파일명은 **카테고리이지 명령 이름이 아니다**. `inspect.ts` 는
  screenshot·snapshot·console·network 를 등록한다
- `src/core/` — 세션 저장, 크롬 실행/연결, 소유권 판정, 앵커, 경로 루트(`paths.ts`)
- `src/cdp/` — 페이지 리졸버, emulation, dom-actions
- `src/core/schema.ts` — 새 명령을 `SEMANTICS` 에 분류 없이 추가하면 `test/schema.test.ts` 가
  깨진다. 그게 이 표가 안 낡는 이유다

스모크에는 **자동 은퇴 장치**가 있다. 알려진 결함은 `known` 으로 표시해 CI 를 막지 않지만,
고쳐져서 **통과하기 시작하면 `STALE` 로 실패**시킨다 — 표시가 남은 채 결함이 사라지면 그 검사는
영영 아무것도 지키지 않으니까.

---

## 막혔을 때

**`Chrome not found`**
자동 탐색에서 못 찾았다. 어디를 봤는지는 `tirno setup --check` 로 보고, `tirno setup` 으로
받거나 `tirno chrome set /path/to/chrome` 으로 적어 두거나 `tirno new s1 --executable-path
/path/to/chrome` 으로 직접 준다. `--executable-path` 값은 메타에 남아 `restart` 가 물려받는다.

**`Refusing to connect` / `Refusing to kill`**
소유권 판정이 `ours` 가 아니다. `tirno ls` 의 `OWNER` 열을 본다. `ghost`(pid 도 리스너도 없음)면
`tirno gc` 로 장부만 걷으면 되고, `foreign` 이면 그 포트는 남의 프로세스다 — 죽이지 않는 게 맞다.

**`error: unknown option '-s'`**
`-s` 는 하위 명령 뒤에 온다. `tirno eval "1+1" -s demo`

**`that element is no longer in the document — … Run "tirno snapshot" and use the new ref`**
`@ref` 가 만료됐다. 그 세션에서 `snapshot` 을 다시 찍는다. 여러 세션이면
`broadcast snapshot --group <g>`.

**명령이 실패했는데 스크립트가 성공으로 읽는다**
실패는 전부 **exit 1** 이다 — 실패한 navigation, 없는 세션, 거부된 kill, `broadcast` 의 부분
실패, `eval` 이 페이지에서 받은 예외까지. 실패의 종류는 stderr 마지막 줄 `code: <code>` 로 가른다
(목록은 `tirno schema | jq .errors`). `drift` 는 선언한 플래그와 실행 중 프로세스가 다르면
1 로 끝나므로 게이트로 쓸 수 있다.
