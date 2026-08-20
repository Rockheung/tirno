# 작업 일지

## 2026-05-05

이 세션에서 chromux를 점검하고, 여러 phase에 걸쳐 개선/흡수 작업을 진행한 뒤 두 차례 rename(chromux → wandr → tirno)을 거쳤다.

---

### Phase 4 — emulation 영속화 + DPR + ls 가시화 (PR #1)

#### 발견한 문제

검증 시나리오를 따라 도구를 돌리는 도중 두 개의 명백한 버그.

1. **`emulate --device "iPhone 14"`가 다음 명령에서 무효화됨**
   - `eval`/`screenshot` 실행 시 viewport 800x600, UA 데스크톱으로 reset
   - 원인: `puppeteer.connect()`의 default `defaultViewport: { width: 800, height: 600 }`가 매 connect마다 페이지에 적용 — chromux는 stateless 모델로 명령마다 connect/disconnect 하므로 emulate 결과가 다음 명령에서 덮어써짐

2. **`trace start` → `trace stop` 실패** — `Protocol error (Tracing.end): Tracing is not started`
   - 원인: stateless connect/disconnect 모델과 stateful tracing의 충돌. start 후 disconnect 되면서 tracing이 끊기고, 다음 stop은 새 connection이라 시작된 trace를 모름

#### 수정

- `src/core/chrome-connector.ts` — `defaultViewport: null` 추가 → 800x600 강제 제거
- `src/cdp/emulation.ts` (신규) — `applyEmulation`/`clearEmulation` 헬퍼. 처음에 CDP 직접 호출(`Emulation.setDeviceMetricsOverride` + `setUserAgentOverride` + `setTouchEmulationEnabled`)을 시도했으나, UA/touch가 CDP session 단위라 detach 시 reset되는 문제 발견 → `page.emulate(device)` 사용으로 변경 (puppeteer가 main session에 보내서 page wrapper lifetime 동안 유지)
- `src/commands/emulate.ts` — emulation 상태를 `SessionMetadata.emulation`에 저장 (device/viewport/network/cpu)
- `src/core/chrome-connector.ts` connect 후 store에 저장된 emulation을 자동 재적용 → 모든 후속 명령에서 emulation 살아남음
- `src/commands/perf.ts` — `trace start`/`trace stop` 분리 명령 → 단일 `trace --duration <s>` (기본 5초). stateless 모델과 정합
- `src/commands/inspect.ts` — `page.viewport()`가 `defaultViewport: null` 환경에서 null 반환 → screenshot dimension을 PNG 헤더에서 직접 파싱

#### 추가 — DPR 단독 옵션

device 없이 DPR만 바꾸는 길이 없어 `--dpr <n>` 옵션 추가. device + dpr 조합 시 page.emulate(device) 후 setViewport로 dsf 보강. `--reset` 옵션도 추가.

#### ls 가시화

`SessionMetadata.emulation`을 `ls`의 새 EMULATION 컬럼에 표시 (예: `iPhone 14 (390x663@3x), net:4g, cpu:4x`).

#### 검증

- iPhone 14 적용 후 새 connection의 eval에서 viewport 390x663, UA iPhone, touch=true, dpr=3 모두 유지
- `nav https://www.google.com` 후에도 emulation 유지
- screenshot 780x1326 (390x663 × dpr2) 정확
- `trace --duration 3` → 109KB chrome://tracing 호환 JSON 정상 생성
- `--dpr 1.5` 단독, `--device + --dpr` 조합 모두 적용
- ls EMULATION 컬럼 정상

#### 남은 한계 (PR에 명시)

- `emulate --reset` 시 viewport/UA는 데스크톱 복귀하나 touch는 안 풀림 (puppeteer 24 안정 API에 setTouchEmulationEnabled를 main session에 보내는 길이 없음)
- `console` 명령은 stateless 한계로 항상 비어있음 ("requires active CDP listener" — daemon 없이 캡처 불가)

---

### git 정체성 정리

#### 발견

Phase 4 첫 커밋이 회사 이메일(`redacted@example.com`)로 사인됐다. chromux는 개인 레포라 이전 커밋들은 `rockheung@gmail.com`. mismatch 발생.

원인: 현재 git config의 default `user.name`/`user.email`이 회사로 되어있었고, chromux 레포는 별도 `--local` 설정이 없었음.

#### 수정

1. `git -c user.name=Rockheung -c user.email=rockheung@gmail.com commit --amend --no-edit --reset-author` + force-with-lease push

   하지만 이 커밋도 GitHub에서 unverified로 표시됨 — 사인은 회사 GPG 키(`REDACTED-KEY-ID`)로 됐는데 author는 개인 → key/email mismatch

2. 다시 `commit --amend --no-edit` (이때는 includeIf 적용 후라 자동으로 개인 키로 사인) + force-with-lease push → GitHub `verified: true` 확인

#### includeIf로 영구 분리

```ini
# ~/.gitconfig
[includeIf "gitdir:~/work/"]
    path = ~/.gitconfig.work
[includeIf "gitdir:~/rockheung/"]
    path = ~/.gitconfig.personal
```

- `~/.gitconfig.work` — Rockheung / redacted@example.com / signingkey REDACTED-KEY-ID / gpgsign true
- `~/.gitconfig.personal` — Rockheung / rockheung@gmail.com / signingkey FB41F5F025F5B050 / gpgsign true
- 메인 `~/.gitconfig`의 default `[user]`는 제거 — 외부 폴더에서 commit 시도 시 user 미설정으로 git이 거절 → 의도적으로 인지 가능

#### GPG 키 검증

GitHub `users/Rockheung/gpg_keys` public endpoint로 확인. `FB41F5F025F5B050`가 `rockheung@gmail.com` 매핑으로 등록됨 → 개인 키 사인은 GitHub에서 verified.

---

### Phase 5-1 — a11y @ref + scroll + wait 흡수 (PR #2)

#### 의도

agent-browser/yansfil-chromux 분석 후, 가장 작고 가치 큰 흡수 항목으로 a11y `@ref` + scroll + wait 선정.

#### 구현

- `src/core/ref-store.ts` (신규) — ref → backendDOMNodeId 매핑을 `~/.tirno/refs/<session>.json`에 저장/조회
- `src/cdp/dom-actions.ts` (신규) — `clickByRef`/`fillByRef` 헬퍼. `DOM.resolveNode` → `Runtime.callFunctionOn`(scrollIntoView + click)
- `src/commands/inspect.ts` — snapshot이 puppeteer wrapper 대신 CDP `Accessibility.getFullAXTree` 사용. 각 노드에 `@N` 부여하면서 출력하고 ref-store에 매핑 저장
- `src/commands/input.ts`:
  - `click <selector|@N>` — `@N`으로 시작하면 ref 경로
  - `fill <selector|@N> <value>` — 동일
  - `scroll up|down|<pixels>` — `--step` 옵션 (기본 600)
  - `wait <ms>` — 단순 sleep (commander 옵션-인자 충돌로 단일 mode)
  - `wait-for <selector>` / `wait-for --network-idle` — selector 또는 네트워크 idle 대기

#### 검증

- example.com snapshot에서 `@7 link "Learn more"` 확인 → `click @7` → IANA 페이지 navigation
- google.com에서 `@39` 검색 textbox에 `fill @39 "chromux test"` → `document.activeElement.value === "chromux test"`
- HN에서 `scroll down` → scrollY 0→242, `scroll 200`, `scroll up` 모두 정상
- `wait 500` 약 588ms (overhead 포함)
- `wait-for h1 --timeout 2000` HN에 h1 없음 → 정상 timeout
- `wait-for --network-idle --timeout 5000` 정상
- `wait-for "input[type=text]" --timeout 5000` 정상

---

### agent-browser 직접 검증

별도 도구로서의 완성도 평가를 위해 `npx agent-browser`로 직접 검증.

#### 5개 세션 병렬

```
naver / google / youtube / grok / x
```

모두 정상 접속. 각 세션은 독립 Chrome 인스턴스 + 별도 user-data-dir → cookies/storage/auth 격리.

#### 격리 정합성

직접 검증으로 확인:
- session a에 `localStorage.setItem("token","SESSION_A_ONLY")` → session b에서 `null`
- session a에 cookie set → session b에 비어있음
- 각 세션별 user-data-dir이 `/var/folders/.../T/agent-browser-chrome-<uuid>` 임시 디렉토리

⚠️ 기본은 ephemeral. 영구 프로필은 `--profile <path>` / `AGENT_BROWSER_PROFILE` 환경변수 또는 `auth save`/`auth login` 사용.

#### Headless / 엔진 / 키

- 기본 headless (`--headed`로 visible)
- `--engine`: `chrome` (default), `lightpanda` 두 개. **Safari 미지원** (CDP 비호환)
- chat 명령은 **`AI_GATEWAY_API_KEY` 전용** — Vercel AI Gateway broker. ANTHROPIC/OPENAI 등 vendor key 직접은 미인식
- `--args` 옵션으로 Chrome flag 전달 가능 — host-resolver-rules 등도 됨 (단 comma split 충돌 시 newline 또는 env 사용)
- 외부 Chrome 띄운 뒤 `connect <port>`로 attach도 가능

#### Annotated screenshot

`screenshot --annotate`가 a11y refs 위에 numbered 라벨(빨간 박스 + `[N]`)을 그린 PNG + legend 출력. 즉 vision 모델 입력으로 즉시 사용 가능한 Set-of-Mark이 1급 기능.

---

### chromux → wandr rename (PR #3)

#### 동기

- npm `chromux@0.2.0` (yansfil) 이미 점유 + 컨셉 거의 동일 ("tmux for Chrome tabs — zero-dependency parallel Chrome tab controller via raw CDP")
- 검색/디스커버리 충돌
- agent-browser와 비교했을 때 chromux의 직접 경쟁력은 약함 (broadcast 정도만 차별)
- 다음 방향(agent self-journaling 메모리 레이어)이 web/CDP에 묶이지 않으므로 이름도 더 추상적으로

#### 후보 평가

1차(웅장한 톤): trodden / waylore / kenning / etchlog → 사용자 피드백 "너무 웅장"
2차(가벼운 톤): wandr / hintly / cluely / niblet / dabbled → **wandr** 채택 (이 시점)

선정 사유:
- "wander"의 캐주얼 표기 (wan-der). 짧고 발음 명확
- agent가 사이트들 휘적휘적 다니면서 알아낸 거 적어두는 도구라는 컨셉 정합
- 다음 phase(자기 시행착오 누적)와 메타포 자연스럽게 이어짐
- npm/GitHub 이름 가용

#### 변경

- GitHub repo `Rockheung/chromux` → `Rockheung/wandr`
- `package.json`: name=`wandr`, bin=`{wandr: ./bin/wandr.js}`
- `bin/chromux.js` → `bin/wandr.js`
- `src/util/errors.ts`: `ChromuxError` → `WandrError`
- `~/.chromux/` → `~/.wandr/` (sessions/profiles/refs/active/tmp 모두)
- `/tmp/chromux-{trace,heap,diff}-*` → `/tmp/wandr-*`
- 모든 user-facing 'chromux' 문자열 일괄 치환
- CLAUDE.md, `.claude/skills/wandr.md` 갱신 (Phase 4/5-1 결과까지 반영)

기존 `~/.chromux/` 데이터는 마이그레이션 없음 (toy 단계).

---

### wandr → tirno rename (PR #4)

wandr가 머지된 직후, 더 멋있는 이름을 LOTR에서 찾자는 사용자 의향에 따라 후보 재검색.

#### 후보 평가 (LOTR 톤)

npm 가용 후보: mathom / mazarbul / westmarch / bagend / earendil / ithil / imladris / ennor / lothlorien / **tirno** / thain

(TAKEN으로 빠진 멋진 것들: palantir, strider, mithrandir, hobbit, shire, rivendell, sting, anduril, olorin, lorien)

1순위 후보 비교:
- **mathom** — 호빗어 "쓸모없지만 버리고 싶지 않은, 모은 작은 물건". 누적 메타포는 정확하지만 호빗 단어
- **tirno** — elvish "watcher". 짧고 (5자, tir-no), agent의 observe 측면

→ 사용자 선택: **tirno**

#### 변경

- GitHub repo `Rockheung/wandr` → `Rockheung/tirno`
- `package.json`: name=`tirno`, bin=`{tirno: ./bin/tirno.js}`
- `bin/wandr.js` → `bin/tirno.js`
- `src/util/errors.ts`: `WandrError` → `TirnoError`
- `~/.wandr/` → `~/.tirno/`
- `/tmp/wandr-*` → `/tmp/tirno-*`
- 모든 user-facing 'wandr' 문자열 일괄 치환 (sed 일괄)
- `.claude/skills/wandr.md` → `.claude/skills/tirno.md`
- 같은 PR(#4)에 docs/JOURNAL.md, docs/RESEARCH.md 작성도 포함

---

### Phase 4-hotfix — Akamai 봇 차단 우회 (PR #5)

#### 발견 흐름

쿠팡 검색 가설 검증 미션에서 모든 요청 403 Access Denied. 진단 단계:

1. **헤더 비교** (httpbin.org/headers) — 정상 Chrome과 100% 동일. UA에 HeadlessChrome 없음, sec-ch-ua/sec-fetch-* 다 정상
2. **JS fingerprint** — `webdriver:false`, `plugins:5`, `languages:ko-KR`, `vendor:"Google Inc."`. 단 `window.chrome.runtime`이 비어있음 (정상 Chrome은 Extension API로 채워짐)
3. **headless 의심** — 코드 확인: default `headless: false` (실제 headful), screen 2056×1329 retina 정상
4. **ps cmdline** — puppeteer가 default로 `--enable-automation` 자동 추가 발견

#### 수정

`src/core/chrome-launcher.ts` puppeteer.launch에 `ignoreDefaultArgs: ['--enable-automation']` 한 줄.

#### 검증

- 쿠팡 메인/검색 결과 200 OK 통과 (이전 5회 시도 모두 403)
- product list 추출 정상 — 비비고/양반/오뚜기/조리고 등
- example.com regression 없음
- 흥미로운 점: `chrome.runtime`은 여전히 빈 채로 나오는데도 통과 → flag 자체가 chrome.runtime보다 더 결정적 신호. CDP 측에 "automation enabled" 표시되거나 헤더/proto에 표시되었을 가능성

#### 한계

- `chrome.runtime` 정상화는 이 fix만으로 안 됨 (`--disable-component-extensions-with-background-pages` 등 다른 default flag 영향 추정)
- TLS fingerprint(JA3)·deeper bot detection에는 별도 stealth plugin 필요. 이번 케이스(쿠팡)는 그 단계까지 안 갔음

---

### Phase 6-1 — URL-keyed visual cache (PR #6)

#### 의도

같은 페이지를 다시 만났을 때 a11y/스크린샷 분석을 처음부터 다시 하지 않도록, **URL key로 snapshot을 캐시**하고 재사용. 스크린샷 자체는 perceptual hash(64bit dHash)로 압축한 뒤 폐기. vision backend 통합은 Phase 6-2.

#### URL key 정책

- `urlPath` = `path + query + hash` (origin만 제거)
- `?q=미역국`과 `?q=라면`은 의도적으로 별개 entry — 사용자 결정. 같은 path 묶기는 향후 user pattern으로
- 매칭 순서: `exact` (full URL) → `urlPath` (origin 무시)

#### 구현

- `src/core/visual-cache.ts` (신규) — `~/.tirno/visual-cache/<domain>/<sha1(urlPath)>.json`. save/lookup/list/prune
- `src/cdp/screenshot-hash.ts` (신규) — dHash. PNG → 9x8 grayscale → 인접 비교 64bit
- `src/cdp/element-info.ts` (신규) — `DOM.getBoxModel`로 bbox, `Runtime.callFunctionOn`으로 안정 selector(id / data-testid / aria-label / name) 추출
- `src/commands/inspect.ts` — `snapshot` 종료 시 자동 적재. 흐름: AXTree → screenshot(viewport) → 각 ref마다 elementInfo (Promise.all) → detach → dHash → save. `--no-cache`로 opt-out
- `src/commands/cache.ts` (신규) — `cache list/load/prune`
- `test/visual-cache.test.ts`, `test/screenshot-hash.test.ts` (신규) — node:test 러너 도입. `tsconfig.test.json`로 분리 빌드(`dist-test/`). 의존성 0 (Node 22 내장). 23 케이스 통과
- `TIRNO_CACHE_DIR` 환경변수로 캐시 디렉토리 override 지원 — 테스트 격리용

#### 데이터 구조

```ts
interface CacheEntry {
  url: string;
  urlPath: string;
  domain: string;
  capturedAt: string;
  visualFp: string;
  viewport?: { w, h, dpr };
  refs: Array<{
    refId: string;     // @1, @2 ...
    role: string;
    name: string;
    selector?: string;
    bbox?: { x, y, w, h };
    backendId?: number;
  }>;
}
```

#### 검증

- example.com snapshot → 자동 적재. `cache load`로 8개 ref + bbox 정상 emit. selector 없음(예상대로 — id/aria-label 없는 단순 페이지)
- google `?q=foo` vs `?q=bar` → urlPath 다르므로 별개 entry. visualFp 다름(`01442000` vs `01002020`)
- google 검색에서 selector 잘 추출 — `#gsr`, `#searchform`, `#APjFqb`(검색창), `[aria-label="지우기"]`, `[aria-label="음성 검색"]` 등
- `--no-cache` flag로 opt-out 정상
- `cache prune --domain <d>` 정상

#### 한계 (PR에 명시)

- selector best-effort — id/data-testid/aria-label/name 없으면 selector 없이 ref+bbox만
- visualFp는 viewport 한 장 (fullPage 아님) — 스크롤해야 보이는 영역 변화엔 둔감
- bbox는 capture 시점 viewport 기준 — 페이지 reflow/lazy-load 시 stale
- URL pattern 매칭(`/products/:id?*`)은 향후. 현재는 exact / urlPath만
- vision 보강(canvas, image-as-text, custom widget)은 Phase 6-2
- `nav --recall` 같은 자동 emit은 별도

---

## PR 목록

| # | 제목 (실제 머지 시점 기준) | 상태 |
|---|---|---|
| [#1](https://github.com/Rockheung/tirno/pull/1) | feat: Phase 4 — emulation 영속화 + DPR + ls 가시화 | merged |
| [#2](https://github.com/Rockheung/tirno/pull/2) | feat: Phase 5-1 — a11y @ref + scroll + wait 흡수 | merged |
| [#3](https://github.com/Rockheung/tirno/pull/3) | chore: rename project chromux → wandr | merged |
| [#4](https://github.com/Rockheung/tirno/pull/4) | docs: 작업 일지 + 리서치 문서화 + wandr → tirno rename | merged |
| [#5](https://github.com/Rockheung/tirno/pull/5) | fix: `--enable-automation` flag 제거로 Akamai 봇 차단 우회 | merged |
| [#6](https://github.com/Rockheung/tirno/pull/6) | feat: Phase 6-1 — URL-keyed visual cache + node:test | open |

## 보류된 항목 (다음 phase 후보)

- **agent self-journaling 메모리 레이어** — 사용자가 가장 관심 있어한 방향. agent의 시행착오를 자동 누적/재호출 (Level 1: append-only journal → Level 4: memory-augmented agent)
- **emulate `--reset` 시 touch 미해제** — puppeteer 24 안정 API 한계
- **`console` 명령 stateless 한계** — daemon 없이 메시지 캡처 불가
- **vision segmentation 통합** — annotated screenshot 위에 OmniParser/SAM2 등 결과를 더해 visual-only 영역(canvas, custom widget) 학습
