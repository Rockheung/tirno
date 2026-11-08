# CLAUDE.md

## 프로젝트 개요

tirno — Multi-session browser automation CLI on raw CDP.
여러 Chrome 인스턴스를 세션으로 관리하고, CDP 명령을 CLI로 실행한다.
**puppeteer 가 없다.** 기동(`cdp/launch.ts`) · 전송(`cdp/client.ts`) ·
브라우저/페이지(`cdp/browser.ts` · `cdp/page.ts`) · 입력(`cdp/input.ts`) 전부 tirno 것이고,
CDP 층은 WebSocket 까지 런타임 의존이 없다(전역 `WebSocket`). 프로토콜 타입은 `devtools-protocol`(타입 전용).

## tirno 가치 흐름 (불변)

목표 도달 시도 우선순위 — 위에서 아래로 시도, 마지막은 자존심 굽혀 부탁:

1. **cache lookup** — 결정론, ms 단위
2. **multi-channel fallback** (selector → a11y → bbox) — 결정론, ms 단위
3. **CDP 직접 분석 + 자율 시도** — 페이지 구조를 뜯어보며 행동경로를 찾는다
4. **사용자 시연 부탁** (`tirno trail capture`) — **마지막 보루**. 위 모두 실패 시 자존심 굽혀 부탁. 부담을 인정하고 명시적으로 요청.

`record / replay / trail capture` 는 4번에 해당. 메인 가치는 1~3의 결정론 흐름이고,
그게 강해질수록 4번 호출 빈도가 줄어드는 것이 self-journaling 의 진짜 의의다.

1·2번은 캐시 경로에서 돈다 — `cache load` 가 지문을 대봐 STALE 을
판정하고, waypoint 를 `dom.selector → a11y → bbox` 로 되찾아 ref store 를 채운다.
새 세션에서 `cache load` 뒤 바로 `click @N`. 남은 어긋남은 selector 채널의 적용 범위(안정적인
속성이 있을 때만 적힌다)이고 README 의 "아직 구현이 아닌 것(drift)" 절에 근거와 함께 있다.

**tirno 안에 LLM 은 없다.** 지능이 필요한 판단은 **tirno 를 호출하는 쪽**이 한다. 이 도구는
결정론적인 관측과 조작만 제공하고, 그 경계가 흐려지지 않게 유지한다.

## tirno 작업 원칙 (불변)

- **삽질을 통해 성공 경로를 기록.** 첫 시도 실패 시 다양한 우회로를 끝까지 시도하되, 발견한 사실(성공/실패 모두)은 cache/journal에 기록한다.
- **성공 패턴을 효과적으로 재활용.** 같은 작업 반복 시 cache load로 즉시 재사용. 그 위에 매번 처음부터 분석 반복하지 않는다.
- **지시를 성공할 때까지 사용자를 찾지 않는다.** 본질적 차단(없는 자격, 권한 부재 등) 외에는 자율 시도. 막힌 경우에도 모든 시도 흔적을 정리한 후 명확한 결과 보고. "할까요?" 같은 중간 확인은 작업 자율성을 깨뜨리므로 금지.
- 위 세 항목은 RESEARCH.md의 "agent self-journaling" 컨셉과 일치 — tirno의 존재 이유.
- **default viewport는 1920x1080.** layout/스크린샷 재현성과 visual cache의 viewport-key 매칭 정합성 위해 고정. `tirno new` 시 chrome flag로 자동 적용. 사용자가 다른 사이즈가 필요하면 `--` 뒤에 `--window-size=...` 또는 `tirno emulate --viewport <wxh>`로 명시.

## 빌드

```bash
npm install
npm run build    # tsc → dist/
```

## 테스트

```bash
npm test    # tsc -p tsconfig.test.json → node --test (유닛)
```

유닛 테스트는 **Chrome 을 띄우지 않는다.** `lsof` 출력·`DevToolsActivePort` 본문·chrome
커맨드라인은 전부 캡처한 문자열이고, 파일을 쓰는 테스트는 `mkdtempSync` + `TIRNO_DIR`
override 로 실제 `~/.tirno` 와 격리된다. 그래서 빠르고 호스트에 무관하지만, 증명하는 것은
**파서·판정 로직이지 Chrome 의 행동이 아니다** — 그쪽은 스모크로 확인한다:

```bash
node bin/tirno.js new test --headless --ephemeral
node bin/tirno.js nav https://example.com
node bin/tirno.js screenshot --out /tmp/test.png
node bin/tirno.js kill test --clean
```

## 구조

- `src/core/` — 세션 저장, Chrome 실행/연결, 프로세스 관리, ref store, 메트릭, visual cache · trail · record 저장소(`visual-cache` · `trail-store` · `record-store`, 파일 백엔드),
  그리고 앵커 브로커 (`anchor-store` · `inventory`(소유권 판정) · `devtools-port` · `gc` ·
  `drift` · `path-guard`). 브라우저 조달은 `chrome-finder`(어느 것을 쓰나) ·
  `provision`(없으면 받아온다) · `unzip`(zip 리더를 직접 든다 — `unzip` 을 부르면
  그것이 곧 새 전제조건이다)
- `src/commands/` — CLI 명령. 파일명은 카테고리이지 명령 이름이 아니다 (`inspect.ts` 는
  screenshot/snapshot/console/network 를 등록한다 — `tirno inspect` 라는 명령은 없다)
- `src/cdp/` — **CDP 클라이언트 자체**: `client`(WebSocket 전송·세션 다중화) · `launch`(기동, 기준
  인자) · `browser` · `page`(evaluate·네비게이션 대기·스크린샷·에뮬레이션) · `input`(Keyboard/
  Mouse, `us-keyboard-layout` 표) · `known-devices`. 그 위에 페이지 리졸버, emulation, dom-actions, element-info, iou, screenshot-hash,
  `resources`(렌더러가 들고 있는 응답), `network-capture`(한 창의 요청 — `network` 와
  `net export` 가 공유), `ref-guard`(`@N` 이 아직 그때 그것인가)
- `src/output/` — 터미널 테이블, 스크린샷 파일 쓰기, HAR 직렬화
- `core/schema.ts` — `tirno schema` 의 생성기. 구조는 commander 트리에서 자동 추출하고,
  의미(`effects`·`destructive`)만 `SEMANTICS` 표로 선언한다. 새 명령을 분류 없이 추가하면
  `test/schema.test.ts` 가 깨진다 — 그게 이 표가 안 낡는 이유다
- `src/util/` — 에러 타입, 인자 파서

## 의존성

- (번들 밖) lighthouse — `tirno audit` 이 실행 시점에 찾는다(`core/plugin-lighthouse.ts`: `$TIRNO_LIGHTHOUSE` → `~/.tirno/plugins/audit` → `npm root -g` → 레포 node_modules). devDependency 라 개발·스모크에는 있고 바이너리에는 없다. 실행은 Node 자식 프로세스에서 하므로 `audit` 에는 PATH 의 Node 가 필요하다. 사용자는 `tirno plugin install audit`
- devtools-protocol (devDependency, 타입 전용): `cdp.send('Page.navigate', …)` 의 파라미터·응답 타입
- commander: CLI 프레임워크
- chalk: 터미널 컬러
- pixelmatch + pngjs: 스크린샷 비교
- lighthouse (devDependency, 번들 밖): `tirno audit` — 위 참조

## 번들에 넣지 않는 것

- OCR · 임베딩 · 벡터검색 · LLM 은 tirno 에 없다. 필요해지면 lighthouse 처럼 번들 밖 플러그인으로 붙인다.
- `~/.tirno/metrics.jsonl` 에 집계 대상이 아닌 종류의 줄이 있어도 `aggregate()` 는 건너뛴다(`core/metrics.ts`).
