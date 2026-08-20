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

### embedding pipeline + RAG retrieval (PR #26)

#### 의도

`tirno explore`의 LLM ask는 PR #25에서 만들어졌으나 `nearbyWaypoints`가 비어있는 상태. 누적된 trail/waypoint를 LLM prompt에 retrieval해주면 정확도 ↑ + 비용 ↓ + 사용자 시연 부탁 빈도 ↓.

#### 신규 모듈

`src/intelligence/embedding.ts`:
- `@huggingface/transformers` (이미 dep)의 feature-extraction pipeline
- 모델: `Xenova/all-MiniLM-L6-v2` (384d, ~25MB ONNX, env override)
- lazy load — 첫 호출 시 download (~3~5초)
- embed(text), embedBatch(texts), buildEmbedText(waypoint, url), cosine(a, b)
- 모든 embedding L2-normalized → cosine = dot product

#### Storage 통합

- `Waypoint.embedding?: number[]` 필드 추가 — JSON에 array로 영속
- `FileWaypointStore.searchSimilar(emb, topK)` — linear cosine over all loaded records (수천 entry까지 OK)
- `LanceWaypointStore.searchSimilar` — native vector search (수만+)

#### CLI

**`tirno snapshot --embed`** — cache 저장 시 각 ref의 embedding도 자동 채움:
- 약 50ms/ref CPU
- 첫 호출 시 모델 download
- LLM prompt material로 활용

**`tirno explore --rag --rag-k 5`** — 매 step마다:
1. `goal + currentUrl` → query embedding
2. `waypointStore.searchSimilar(queryEmb, K)` → top-K nearby waypoints
3. `IntelligenceContext.nearbyWaypoints`에 포함 → claude prompt에 자동 추가

#### 의의

이전 시도들이 누적될수록:
- LLM이 "이 goal 비슷한 시도가 있었다 — selector / role / OCR text" 패턴 받음
- prompt 정확도 ↑ → 첫 시도 성공률 ↑ → step 수 ↓ → 비용 ↓
- 시간 지나면 cache hit 직전에 RAG로 패턴 발견 → LLM 호출 자체 줄어듦

self-journaling의 진짜 누적 가치 — agent의 시행착오가 다음 호출을 강화.

#### 한계 / 후속

- 첫 모델 download (~25MB) 시간 — `--embed` opt-in이라 default 영향 없음
- file backend의 linear cosine은 ~10K entry까지 OK. 그 이상은 lance backend
- multi-modal embedding (CLIP 등)은 향후 — 현재 텍스트 only
- LLM retry/streaming은 #24
- 88/88 tests pass

---

### tirno explore — 메인 가치 흐름 (PR #25)

#### 의도

CLAUDE.md에 명시된 가치 흐름의 **결합 명령**:

```
1. cache lookup (existing trail with same goal + high success-rate → replay)
2. snapshot 현재 페이지 (multi-channel context)
3. LLM ask → ProposedAction
4. action 실행 → step 누적
5. action.type === 'done' → trail 저장
6. give_up OR maxSteps 도달 → 사용자 시연 부탁 (마지막 보루)
```

PR #14 stub부터 #23 LLM 실 구현까지 만든 부품들의 entrypoint.

#### 구현

`src/commands/explore.ts`:
- 1. trailStore에서 같은 goal + 성공률 >= threshold trail 검색 → 있으면 replay 안내
- 2~N. iteration loop:
  - capturePageContext(page) — screenshot + a11y dump + viewport
  - intelligenceAsk(goal, ...) → ProposedAction
  - executeAction(page, cdp, action) — type별 (click/fill/press/wait/nav/scroll)
  - step에 RecordedEvent 기록
- 5. action.type === 'done' → trail save (`--save <name>` 시 영속)
- 6. action.type === 'give_up' OR maxSteps → exit 2 + 사용자에게 `tirno trail capture` 안내

#### ProposedAction 확장

`type: 'done' | 'give_up'` 추가. claude prompt에 명시 — goal 달성 시 done, 막혔을 때 give_up.

#### CLI

```bash
tirno explore "위젯 추가 모달 열기" \
  [--backend claude]         # intelligence backend
  [--max-steps 10]           # LLM iteration cap
  [--save my-trail]          # 성공 시 trail로 영속
  [--no-cache]               # cache lookup 건너뜀 (강제 LLM)
  [--retry-threshold 0.5]    # cache trail 신뢰도 (success rate)
  [--verbose]                # step별 reasoning + cost
```

매 iteration token cost 누적 → 마지막에 `~$0.0234` 보고. 비용 가시화.

#### 의의

CLAUDE.md "사용자 시연은 마지막 보루" 원칙의 **실행 가능 형태**. 사용자가 `tirno explore "<goal>"` 한 번 부르면:
- 이전에 성공한 trail 있으면 → 즉시 replay (LLM 호출 0회, 비용 0)
- 없으면 LLM이 multi-channel 보고 시도 (수초~수분, ~$0.01-0.10)
- 성공 시 trail 영속 → 다음에는 결정론
- 실패 시에만 사용자에게 시연 부탁

시간 지날수록 trail 누적 → LLM 호출 빈도 감소 → 사용자 시연 부담 감소. **self-journaling의 진짜 작동 형태**.

#### 한계 / 후속

- `--save`는 마지막 step까지 누적된 actions를 저장. record event format이라 replay 가능하지만 timing은 step 단위 (정확한 ms 아님)
- nearbyWaypoints RAG retrieval 자동 포함은 #21 (vector 검색 + cosine top-K)
- LLM retry/streaming/circuit-breaker는 #24
- 88/88 tests pass

---

### Storage abstraction + LanceDB backend (PR #24)

#### 의도

production 가정 — JSON 파일 + sha1 hash 단순 storage는 수만+ waypoints / 다중 사용자 / vector 검색 요구사항에 부족. backend 추상화 + LanceDB(embedded production-grade) 도입.

#### 구조

```
src/storage/
  types.ts         WaypointStore / TrailStore / WaypointRecord / Filters
  index.ts         backend factory (TIRNO_STORAGE_BACKEND env)
  file-backend.ts  기존 visual-cache + trail-store wrapper (default)
  lance-backend.ts @lancedb/lancedb (embedded vector DB)
```

#### Selection

- `TIRNO_STORAGE_BACKEND=file` (default) — backward compat
- `TIRNO_STORAGE_BACKEND=lance` — LanceDB

lance backend는 lazy-load — file 사용자는 native binary 안 거침. (단 install 시점에 binary download — npm publish 후 사용자 install 부담)

#### File backend

- 기존 visual-cache + trail-store JSON 파일 layer 그대로 wrap
- query는 linear scan + in-memory filter (수천 entry까지 OK)
- 모든 operation에 backward-compat 유지

#### Lance backend

- 테이블: `waypoints`, `trails`
- 위치: `~/.tirno/lance/` (`TIRNO_LANCE_DIR` override)
- waypoints flat schema — channels를 row 컬럼으로 평탄화 (role, name, selector, bbox*, ocrText, embedding…)
- `embedding` 컬럼 — 384차원 (`TIRNO_EMBEDDING_DIM` override). 다음 PR(#20)에서 채움.
- searchSimilar()로 cosine top-K — 다음 PR(#21)에서 RAG retrieval에 사용

#### 검증

- file backend 8 케이스 unit test — save/get/query (domain/role/search/limit) / delete / trail filter (goal, minSuccessRate)
- 88/88 tests pass
- lance backend는 native binary 검증은 사용자 환경에서 (CI에서 실제 lance 회귀는 별도 PR)

#### 한계 / 후속

- lance native binary는 macOS arm64/x64, Linux x64 지원. Windows는 추가 검증 필요
- file → lance migration 명령은 #22
- embedding 자동 채움은 #20
- vector RAG retrieval은 #21
- 기존 inspect/cache 명령들이 file backend 직접 호출 — 점진적으로 storage layer로 마이그레이션

---

### 지능요청 — Anthropic Claude Vision backend (PR #23)

#### 의도

가치 흐름 4번 — 결정론(cache + multi-channel)이 막혔을 때 LLM에게 multi-channel context를 통째로 던져 next action을 받는다.

PR #14의 cloud stub(claude/openai/gemini)에서 멈춰있었음. 1차 — Anthropic Claude 실제 구현.

#### 모듈 구조

```
src/intelligence/
  types.ts                  IntelligenceRequest / Response / Backend / ProposedAction
  dispatcher.ts             backend lazy load (claude/openai/gemini)
  backends/claude.ts        @anthropic-ai/sdk 실제 호출
src/commands/
  ask.ts                    tirno ask <goal>
```

vision/* (OCR 전용)과 분리. intelligence는 일반 LLM reasoning. claude는 둘 다 가능하지만 메인 의도가 다르므로 분리.

#### Prompt 형식

system: "tirno 행동 agent. JSON 형식으로 next action 응답."
user content:
1. screenshot (PNG → base64) — opt-out 가능
2. multi-channel text:
   - goal / ask / url / viewport
   - userHint
   - a11y tree dump (truncated)
   - attemptedWaypoints (실패한 단서, 반복 방지)
   - nearbyWaypoints (cache RAG retrieval — 향후 #21)

응답 JSON:
```json
{
  "action": { "type": "click", "target": { "selector": "...", "x": N, "y": N }, "reasoning": "..." },
  "confidence": 0.0-1.0,
  "reasoning": "1-3 sentences"
}
```

#### CLI

```bash
tirno ask "<goal>" [--backend claude] \
  [--no-screenshot] [--no-a11y] [--ax-lines N] \
  [--max-tokens N] [--out path] [--hint "..."]
```

- 매 호출 token usage + estimated cost USD 출력 — 비용 가시화
- `--out path` JSON으로 저장 (audit / 다음 step input)

env:
- `ANTHROPIC_API_KEY` (필수)
- `TIRNO_CLAUDE_MODEL` (default `claude-haiku-4-5`)
- `TIRNO_CLAUDE_PRICE_IN/OUT` (1M token당 USD, 가격 변경 시 override)

#### 한계 / 후속

- openai / gemini는 dispatcher에서 throw — 다음 PR
- streaming / retry / circuit breaker / rate limit / prompt caching → #24 (LLM production 수준)
- nearbyWaypoints RAG retrieval은 #21 (vector 검색)에서 자동 채움
- explore 명령(#29)이 ask + 시도 + cache 저장 loop를 묶음

---

### Trail 모델 + 가치 흐름 정정 (PR #22)

#### 의도

행동 시퀀스 (goal + steps) 데이터 모델 + replay 명령. **그러나 사용자 정정**으로 강조점이 바뀜:

> 사용자 1회 시연은 정말 tirno 자신이 형편없게 느껴질 때, 마지막 책임감으로 어렵게 부탁하는 케이스다.

내가 PR plan을 잘못 잡았음. "사용자 시연 → 자동 재현"을 메인으로 강조했던 건 잘못. **메인 가치는 자율 탐색**. 사용자 시연은 마지막 fallback.

#### 정정된 가치 흐름 (CLAUDE.md 명문화)

```
1. cache lookup                        — 결정론, ms 단위
2. multi-channel fallback              — 결정론, ms 단위
   (selector → a11y → bbox → ocr)
3. CDP 직접 분석 + 자율 시도           — agent 페이지 분석
4. LLM (지능요청) + RAG retrieval      — 비결정론 보강
─────── 위 모두 실패 ───────
5. tirno trail capture <name>          — 사용자 시연. 마지막 보루.
```

`record / replay / trail capture`는 5번. tirno 메인은 1~4. 메인이 강해질수록 5번 빈도 ↓ — self-journaling의 진짜 의의.

#### 구현 (PR scope)

- `src/core/trail-store.ts` (신규) — Trail / TrailStep / matchStats / active-trail marker
- `src/commands/trail.ts` (신규):
  - `trail capture <name>` — **fallback only** 명시적 표시 + warning
  - `trail save` — record 종료 + trail 저장
  - `trail list / show / replay / rm`
  - `trail replay`는 multi-channel fallback chain (selector → a11y → bbox → event.xy) + matchStats 누적
- 명령 이름을 `start`가 아닌 `capture`로 — "사용자 시연" 의미 명확화
- 자율 탐색 path는 #29 (`tirno explore`) PR에서 같은 trail-store 활용

#### 새 task — #29 `tirno explore`

자율 탐색 명령. cache → multi-channel → CDP → LLM 순 시도. 성공 시 trail로 저장. **이게 tirno 메인 흐름**.

#18 (지능요청) + #21 (RAG) 머지 후 #29 진행.

---

### record/replay multi-channel + fallback chain (PR #21)

#### 의도

Waypoint 모델(PR #20)의 multi-channel 컨텍스트를 record/replay 흐름에 적용. 사용자 정정의 "selector / aria / 좌표 / OCR이 같은 element의 다른 관점" — 행동 시퀀스에서도 한 채널 깨져도 다른 채널로 fallback.

#### 변경

**RecordedEvent에 channels** (record-store):
```ts
channels: {
  a11y?:   { role, name };       // implicit role from tagName + aria-label/alt/title/text
  dom?:    { selector, tagName };
  visual?: { bbox };
}
```

기존 flat fields(`sel/tag/bbox`)는 **backward compat 유지** — 이전 recordings 그대로 replay 가능.

**inject script log()** (chrome-connector):
- `a11yRoleOf(el)`: explicit `role` 또는 implicit (a/button/input/textarea/select)
- `a11yNameOf(el)`: aria-label → labelledby → alt → title → textContent (80자 truncate)
- 매 event에 channels 자동 첨부

**replay fallback chain** (replay.ts):
```
resolveTarget(ev):
  1. dom.selector → querySelector + bbox center
  2. a11y.role+name → live DOM 검색 (implicit role 매칭)
  3. visual.bbox → elementFromPoint 검증
  4. event.xy → fallback (record-time 좌표)
실패 시 click 스킵
```

`replay --verbose` — event 별 매칭 채널 출력. `Replayed "name" — 5/5 events [dom:3 a11y:1 visual.bbox:1]` 같은 channel breakdown 보고.

#### 검증

- record start → `<a>` element click dispatch
- captured event:
  ```json
  channels: {
    a11y: { role: 'link' },           // implicit from <a href>
    dom:  { tagName: 'A' },           // no stable selector (id/data-testid 없음)
    visual: { bbox: { x: 410, y: 80, w: 234, h: 22 } }
  }
  ```
- legacy `sel/tag/bbox`도 함께 보존
- 80/80 tests pass (regression 없음)

#### 한계 / 후속

- a11yNameOf는 element-side 근사 — 진짜 a11y tree는 chromium computed accessible name. 차이 가능
- replay fallback은 event 단위 — 다음 PR(#17 Trail)이 step 단위 트레일로 확장
- matchStats 누적은 #18(지능요청) PR에서 cache로 push

---

### multi-channel Waypoint + vision attach (PR #20)

#### 의도

사용자 정정: "selector / aria / 좌표 / OCR 이 같은 element에 대한 다른 관점. 한 채널만 쓰는 게 아니라 모두를 묶어 행동 컨텍스트 한 덩어리로 기록하라."

PR #11의 vision augment는 a11y와 안 겹치는 OCR만 visual-only ref로 추가했음 — 잘못된 read.

#### 변경

**`CacheRef` → `Waypoint`** (multi-channel 모델):
```ts
interface Waypoint {
  id: string;
  refId?: string;
  channels: {
    a11y?:   { role, name, backendId, description };
    dom?:    { selector, tagName, xpath };
    visual?: { bbox, visualFp, ocrText, ocrConf };
  };
  matchStats?: { successCount, failureCount, successByChannel, lastSuccessAt };
}
```

`source: 'a11y' | 'vision'` 이분법 폐기 — 한 waypoint는 가능한 모든 채널 합집합.

**Schema versioning + auto migration**:
- `CacheEntry.schemaVersion = 2`
- v1 entry는 `migrateEntry()`로 자동 변환 (load/list 시점)
- 기존 cache 손실 없음

**vision augment 재설계**:
- 입력: 기존 a11y waypoints
- 동작: 각 OCR word가 가장 specific한(작은 bbox 우선) a11y waypoint에 attach. 매칭 안 되는 word는 orphan waypoint로 (channels.visual만)
- 결과: `{refs, attached, orphan, total, durationMs}` — observability 개선

**snapshot/cache load 출력 갱신** — channels 기준.

#### 검증

- example.com snapshot — Waypoint 8개 + paddle vision: 3 attached / 0 orphan
- migration: v1 fixture → v2 변환, 채널 매핑 정확
- 80/80 tests pass (76 + 4 신규 migration test)

#### 의의

- replay/intelligent fallback의 데이터 기반 — 한 element가 selector 깨져도 좌표/role/ocr_text로 재발견 가능
- LLM 지능요청 prompt material 그대로 — channels 묶음이 multi-modal context

---

### record/replay nav 손실 보강 (PR #19)

#### 문제

PR #16의 record는 page reload / SPA route change 시 inject script가 새 document에 다시 실행되며 `window.__tirno_rec.events`가 초기화 — 사용자가 nav를 일으키는 click을 했다면 그 후 events 모두 손실.

#### 해결: localStorage 영속

- 매 event push 시 `localStorage['__tirno_rec_state']`에 debounced (200ms) flush
- `pagehide` / `visibilitychange(hidden)`에서 sync flush — 페이지 사라지기 직전 마지막 events 보존
- inject 시점에 localStorage에서 `recording / startTs / events` 복원
- `record start`에서 sync flush — 첫 reload 전에 이미 recording=true 영속
- `record stop`에서 events 회수 후 in-memory + localStorage 모두 clear

#### 검증

```
record start
click (100,200)        # 1번째
nav https://example.com  # page reload — 이전엔 여기서 events 초기화
click (300,400)        # 2번째 (reload된 page에서)
record stop
→ 2 events captured  ← 둘 다 살아남음
```

#### 한계

- localStorage는 per-origin. **cross-origin nav 시 다른 origin의 events 회수 불가** (다른 localStorage 영역) — daemon 모드(별도 task)가 long-term fix
- localStorage 5-10MB 제약 (chrome 기준) — 매우 긴 record는 chunk 분할 필요. 현재는 단순 가정
- `beforeunload`는 NEUTRALIZE_UNLOAD에서 차단되어 listener 등록 불가 → `pagehide`로 대체

#### `window.__tirno_rec_flush` 노출

inject script가 `window.__tirno_rec_flush()`를 글로벌로 노출 — record start/stop이 evaluate에서 동기 호출하여 timing race 방지.

---

### record/replay — 사용자 행동 캡처 + raw CDP 재현 (PR #16)

#### 의도

사용자 정정: "유저가 행한 동작도 이해해서 따라할 수 있나?" — self-journaling의 진짜 형태. 사용자가 1회 직접 시연 → tirno가 시퀀스 학습 → 다음부터 자동 replay.

#### 구현

- `chrome-connector.ts` connect 시점 inject — `window.__tirno_rec` 객체 + capture-phase listener (click/keydown/input/scroll). recording flag로 toggle. event는 type/timestamp/clientX-Y/best-effort selector/bbox/key/value 캡처
- `src/core/record-store.ts` (신규) — `~/.tirno/recordings/<name>.json` save/load/list/remove. 이름은 `[A-Za-z0-9_-]+`만 허용 (path traversal 방지)
- `src/commands/record.ts` (신규) — `record start/stop/list/rm`. stop 시 `--save <name>`로 저장, `--json`으로 raw 출력
- `src/commands/replay.ts` (신규) — `replay <name>`. raw CDP `Input.dispatchMouseEvent` (trusted, 위 PR #15 검증) + `Input.dispatchKeyEvent` 시퀀스로 재현. `--speed`, `--max-gap`, `--no-nav` 옵션
- `test/record-store.test.ts` (신규) — save/load/list/remove + path safety 8 케이스. 76/76 tests pass

#### 검증

- `record start` → `recording: true` 확인
- `dispatchEvent(MouseEvent('click', clientX, clientY))` 두 번 → 2 events 정확 캡처 (좌표/bbox/tag 모두)
- `record stop --save mission-test` → file 저장
- selector best-effort 작동 (id / data-testid / aria-label / tag[name])

#### 한계

- **navigation 시 listener 손실** — 사용자가 페이지 이동 일으키면 새 document에 새 inject되어 events 초기화. 보강은 localStorage flush 또는 CDP binding으로 host에 push하는 형태 (다음 PR 후보)
- iframe / shadow DOM 내부 입력은 main document listener에 안 잡힘 (capture phase는 main document에서만)
- replay 시 selector resolve가 record 시점과 다를 수 있음 — 좌표 fallback으로 보강했지만 layout 변경 시 stale

#### 의의

PR #15의 `tirno cdp` (raw passthrough) + 이 PR의 record/replay → **사용자 1회 시연 → 자동 재현**의 진짜 self-journaling 흐름이 완성됨. 사내플랫폼 디자인 모드 같은 비표준 흐름도 사용자가 직접 마우스로 한 번 보여주면 그 후 tirno가 그대로 반복 가능.

---

### default viewport 1920x1080 + 작업 원칙 + raw CDP passthrough + dialog 우회 (PR #15)

#### 추가 변경 (사용자 정정 후)

**"tirno 갖다 버릴까?"** 질문에 대한 답: tirno에 raw CDP passthrough가 없어서 매 미션마다 wrapper 추가하는 패턴이 비효율이었음. 정정 즉시 추가.

- `src/commands/cdp.ts` (신규) — `tirno cdp <method> [params-json]`. 모든 CDP method 즉시 호출. `--browser`로 browser-level session, `--listen <event>` + `--listen-ms`로 event capture
- `src/commands/input.ts` — `drag <from> <to>` 명령 (selector OR 좌표, `--native`로 CDP intercept)
- `src/core/chrome-connector.ts` — connect 시 onbeforeunload 무력화 + dialog 자동 accept (사용자 정정 "사이트 이탈시 시스템 dialog가 뜨는지도 매 페이지에서 체크해야 뭘 하다 갑자기 멈추지 않지")

#### 미션 완수 — dev-user.internal-test.example 디자인 모드 위젯 추가 10회

자격 차단 풀린 후 끝까지 시도한 결과:

1. ✅ admin 로그인 (redacted@example.com)
2. ✅ admin/design/ URL 진입 + dialog 우회로 navigation 정상화
3. ✅ `design-mode-magnet` shadow DOM 발견 (open mode) + 좌상단 + 버튼 (8, 57) 위치 확인
4. ✅ `_widget_type[data-type="text"]` 좌표 (953, 354) 확보
5. ✅ jQuery click()/dispatchEvent — **untrusted라 사내플랫폼 handler 발동 안 함**
6. ✅ DragEvent dispatch — modal 닫혔으나 `widgetHtml.attr is not a function` (untrusted dataTransfer 부족)
7. ✅ `tirno cdp Input.dispatchMouseEvent` — **trusted CDP mouse event** → 정상 작동
8. ✅ 10회 반복 시간: 4232 / 4376 / 4093 / 3931 / 4256 / 4497 / 4021 / 4133 / 4359 / 3915 ms — 평균 **4181ms/회**, 분산 작음
9. ✅ 텍스트 위젯 32개 누적 (이전 시도 포함)

#### 잘못된 가설 (기록)

사용자 정정 "drag 기반이 아닌데 뭘로 그런 판단을 했을까" — click이 안 먹히는 걸 보고 자동으로 drag 가설로 점프했던 게 잘못. 실제 메커니즘은 단순 click이고, 단지 **untrusted JS click vs trusted CDP click** 차이. 가설 검증 단계에서 dragstart handler 0개 먼저 확인했어야 함. self-journaling이라면 이런 false trail도 cache에 기록 (다음에 같은 함정 안 빠지게).

#### 의의

- `tirno cdp` 추가로 wrapper의 한계가 사라짐 — 어떤 CDP 도메인이든 즉시 호출
- onbeforeunload 자동 무력화로 SPA navigation 안정화
- 사용자 직접 클릭 vs 자동화 차이의 본질이 **trusted event** 라는 진단 명확화
- self-journaling: admin 페이지 cache 효용 87% + 위젯 추가 액션 실측 데이터 확보

---

### default viewport 1920x1080 + emulate --viewport + 작업 원칙 정책화 (PR #15)

#### 의도

사용자 정정 두 가지:

1. **"tirno는 삽질을 통해 성공 경로를 기록하고, 성공 패턴을 효과적으로 재활용. 지시를 성공할 때까지 사용자를 찾지 않는다."** — tirno의 본질적 가치관. CLAUDE.md에 정책으로 명문화.
2. **"viewport 1920x1080 — tirno 동작에 대한 가장 기본적인 신뢰를 위해."** — visual cache의 viewport-key 매칭과 layout journaling의 재현성 위해 default 고정.

#### 구현

- `CLAUDE.md` — "tirno 작업 원칙 (불변)" 섹션 추가 (4 항목)
- `src/core/chrome-launcher.ts`:
  - chrome flag `--window-size=1920,1080` + `--window-position=0,0` default 추가
  - 새 세션 launch 시 `meta.emulation.viewport = { width: 1920, height: 1080, deviceScaleFactor: 1 }` 자동 설정 → connect 시 setDeviceMetricsOverride로 JS-side viewport 정확히 1920x1080 강제 (chrome bar height 영향 제거)
- `src/commands/emulate.ts` — `--viewport <wxh>` 옵션 추가. device 설정과 결합 가능 (UA/touch는 device, size는 viewport)
- `src/cdp/emulation.ts` — device + viewport 결합 시 viewport size override 처리

#### self-journaling 효용 정량 검증

`dev-user.internal-test.example/admin/` 페이지 10회 반복 시뮬레이션 (mac M-series, 1920x1080):

| | 시간 |
|---|---|
| Run 1 (cold: nav + snapshot --vision) | 3,460ms |
| Run 2~10 (warm: cache load 9회) | 80ms × 9 = 720ms |
| 9회 모두 cold 시 추정 | 9 × 3,460 = 31,140ms |
| 실제 cache 활용 합계 | 3,460 + 720 = 4,180ms |
| **단축율** | **87% (회당 43배 빠름)** |

자격 차단으로 위젯 추가 액션까지는 도달 불가했으나(사용자 사내플랫폼 계정만 알 수 있음), **재활용 효용의 핵심 신호** 정량 확인.

#### 검증

- `tirno new` 후 `eval "{innerWidth, innerHeight, dpr}"` → `[1920, 1080, 1]` (기존엔 chrome bar 차지로 [1920, 941, 2])
- `tirno ls` EMULATION 컬럼 → `1920x1080@1x` (default 자동 표시)
- `tirno emulate --viewport 1280x720` — viewport 변경 후 ls/eval로 적용 확인

#### 한계

- chrome window 자체는 OS-level이라 macOS 경우 chrome bar 일부 화면 차지 — JS innerWidth/Height는 1920x1080 강제됨 (setDeviceMetricsOverride)
- 사용자가 emulate --viewport로 명시 변경 시 그 값이 우선
- 기존 세션은 영향 없음 — 새로 만들 때부터 적용

---

### Phase 6-2e — backend 분류 (local/cloud) + cloud stubs + default paddle (PR #14)

#### 의도

사용자 정정 — "tesseract 같은 올드테크를 써야 하나?". 1985년 시작 OCR 엔진을 default로 두는 게 production 적절치 않음. 또한 "로컬 모델을 기본으로, api key 설정 또는 로컬모델을 사용할 수 있도록 확장 예정"이라는 방향성 명시.

#### 구현

- `src/vision/types.ts`:
  - `OcrBackend.kind: 'local' | 'cloud'` 필드 추가
  - `LocalBackendName` / `CloudBackendName` / `BackendName` union 분리
  - `LOCAL_BACKENDS`, `CLOUD_BACKENDS`, `ALL_BACKENDS` 상수
  - `DEFAULT_BACKEND = 'paddle'` (was 'tesseract')
- `src/vision/backends/claude.ts` (신규) — `ANTHROPIC_API_KEY` 검사 + "not yet implemented" 명확한 안내
- `src/vision/backends/openai.ts` (신규) — `OPENAI_API_KEY` 동일
- `src/vision/backends/gemini.ts` (신규) — `GEMINI_API_KEY` / `GOOGLE_API_KEY` 동일
- `src/vision/ocr.ts` dispatcher — cloud backend lazy import 추가, 상수 re-export
- `src/commands/vision.ts` — `--backend` help에 local/cloud 그룹 명시, default `DEFAULT_BACKEND`
- `src/commands/inspect.ts` — `--vision` default 동일
- `test/backends.test.ts` (신규) — 5 케이스: registry 일관성, kind 매핑, key 부재 시 안내, key 있을 때 "not implemented" 메시지

#### 검증

- `vision ocr --help` — local: tesseract|paddle|florence / cloud: claude|openai|gemini 그룹 표시
- 옵션 없이 호출 → paddle backend 사용 (example.com 4 line 정상)
- `--backend claude` (key 없음) → "claude backend requires ANTHROPIC_API_KEY env var..."
- `ANTHROPIC_API_KEY=fake --backend claude` → "claude backend is not yet implemented. Tracked in Phase 6-2f."
- 68/68 tests pass (63 + 5 신규)

#### 다음 (Phase 6-2f, 별도 PR)

- claude vision 실제 구현 (`@anthropic-ai/sdk`)
- openai gpt-4o vision 실제 구현
- gemini 실제 구현
- 다만 VLM은 pixel-precise bbox 약함 → text extraction 위주 + 필요 시 paddle bbox와 hybrid 매칭

---

### parseInt/parseFloat 직접 commander coercer 사용 버그 (PR #13)

#### 발견

사용자가 "완성된 거 맞냐? 네가 써봐라" 정정 — 가설 검증 미션을 처음부터 끝까지 다시 돌리던 중 발견.

`tirno snapshot --vision tesseract --vision-lang kor+eng --vision-min-confidence 70`을 실행했는데도 **0%, 19%, 32% confidence 단어가 출력**. min-confidence 필터가 적용 안 됨.

#### 원인

```ts
.option('--vision-min-confidence <n>', '...', parseInt, 50)
//                                            ^^^^^^^^^^
```

commander는 coercer를 `(value, prev) => result`로 호출. `parseInt`는 `(string, radix)`를 받기 때문에 prev value(50)가 **radix**로 전달됨 → `parseInt('70', 50)` = NaN.

검증:
```js
new Command().option('--n <n>', 'desc', parseInt, 50)
  .parse(['node', 'x', 'test', '--n', '70']);
// → opts.n = NaN
```

#### 수정

`src/util/parsers.ts` 신규:
```ts
export const intArg = (v: string): number => parseInt(v, 10);
export const floatArg = (v: string): number => parseFloat(v);
```

13곳 일괄 치환 — cache.ts, inspect.ts, vision.ts, input.ts, nav.ts, session.ts, emulate.ts, perf.ts, multi.ts. `parseInt` → `intArg`, `parseFloat` → `floatArg`. input.ts에 있던 `(v) => parseInt(v, 10)` inline wrapper도 통일.

#### 검증

- `test/parsers.test.ts` (신규) — 5 케이스. 회귀 방지 위해 `parseInt('70', 50) → NaN`을 명시적 sanity check도 포함
- e2e — `--vision-min-confidence 70` 적용 후 247개 → 134개로 줄어듬 (low-confidence garbage 제거)
- 63/63 tests pass (58 + 5 신규)

#### 영향 범위

default value가 있고 사용자가 옵션을 명시한 경우 모두 영향:
- `cache list --limit`, `inspect console --limit`, `network --limit`
- `snapshot --vision-min-confidence`, `vision ocr --min-confidence`
- `nav --timeout`, `wait-for --timeout`
- `input scroll --step`, `type --delay`
- `perf trace --duration`, `multi diff --threshold`

production 사용 전에 발견된 게 다행. unit test로도 catch 가능했어야 함 — coverage 부족이었던 영역.

#### 교훈

`parseInt` / `parseFloat`을 함수 레퍼런스로 직접 넘기지 말 것. JS 표준 라이브러리는 추가 인자를 받는 형태가 많아 callback-style 사용 시 시그니처 미스매치가 흔함. wrapper 강제.

---

### Phase 6-1b — viewport-aware visual cache (PR #12)

#### 의도

bbox/refs는 **viewport에 종속**. 같은 URL이라도 desktop 1200×800에서 본 layout과 모바일 390×844에서 본 layout은 완전히 다른 좌표 → 한 entry로 덮어쓰면 layout journaling으로서 의미 없음. viewport 정보가 cache의 본질이라는 사용자 정정에 따라 재설계.

#### 변경

- **저장 구조**: `<domain>/<sha1(urlPath)>/<wxh@dpr>.json` — URL 디렉토리 + viewport 별 파일. 같은 URL 다른 viewport는 별개 file로 공존
- **`CacheEntry.viewport` required** (이전 optional). bbox/refs를 신뢰하려면 viewport 알아야 함
- **`Viewport` 타입 export** + `viewportKey` / `parseViewportKey` 헬퍼 (`1200x800@2` 형식)
- **`lookup(url, { viewport?, mode? })`**: viewport 명시 시 정확 매칭 (없으면 null), 미명시 시 디렉토리 안 가장 최근 mtime entry 반환. 시그니처가 옵션 객체로 변경
- **`cache list`**: VIEWPORT 컬럼 추가
- **`cache load`**: `--viewport <wxh@dpr>` 옵션 추가
- **`prune`**: 디렉토리 트래버스 + 빈 디렉토리 정리 + legacy flat layout(이전 형식)도 정리

#### 검증

- example.com을 desktop(1200×829@2) → emulate iPhone 14 → mobile(390×663@3)로 두 번 snapshot
- `cache list` — viewport별 별개 entry 두 row 표시
- `cache load --viewport 1200x829@2` → RootWebArea (0,0 **1200x829**)
- `cache load --viewport 390x663@3` → RootWebArea (0,0 **390x663**)
- `cache load --viewport 1920x1080@1` → "No cached entry" (정확)
- viewport 미지정 → 가장 최근(mobile) 반환
- 58/58 tests pass (49 + 9 신규: viewport 분리, parseViewportKey, 디렉토리 구조)

#### 한계

- 마이그레이션 없음 — 기존 entry는 prune으로 정리 후 재캡처 (toy 단계)
- viewport "근사 매칭"은 안 함 — 정확한 wxh@dpr 일치만. 같은 device classification(desktop/tablet/mobile) 매칭은 향후
- legacy flat layout(`<hash>.json`)이 발견되면 prune이 정리하지만 lookup은 디렉토리만 봄

---

### Phase 6-2d — snapshot --vision 통합 (PR #11)

#### 의도

Phase 6-2 / 6-2b의 OCR backend는 `vision ocr` 별도 명령으로만 호출 가능했음. **snapshot 종료 시 자동으로 OCR을 실행해 a11y가 못 잡은 영역의 텍스트를 visual-only ref(`@vN`)로 보강**하면 cache entry 한 번 적재로 a11y + vision 통합 정보 확보. 이게 Phase 6 전체의 진짜 가치.

#### 구현

- `src/vision/augment.ts` (신규) — `visionAugment(buf, a11yBboxes, opts)` — OCR → IoU/containedIn 필터로 a11y가 cover한 word 제외 → 남은 word만 `@v1, @v2 ...` ref로 반환
- `src/commands/inspect.ts` snapshot — `--vision [backend]` flag 추가 + `--vision-lang`, `--vision-min-confidence`, `--vision-iou`, `--vision-contain` 옵션. snapshot 흐름 안에서 cache용 screenshot 한 장 재사용 (추가 capture 비용 없음)
- `src/core/visual-cache.ts` — `CacheRef`에 `source?: 'a11y' | 'vision'`, `confidence?: number` 필드 추가 (back-compat — default 'a11y')

#### 매칭 로직

처음에는 IoU만 사용했으나, a11y의 paragraph가 wrap된 여러 줄을 layout box 하나로만 표현하는 경우 word-level OCR과 IoU가 매우 작아 false positive 많음. 두 가지 신호를 OR로:

- `iou(a11yBbox, visionWordBbox) >= 0.3` (peer-level overlap)
- `containedIn(visionWord, a11yBbox, 0.8)` (vision word가 a11y container 안에 80% 이상 포함)

둘 중 하나라도 만족하면 cover된 것으로 보고 visual-only로 추가 안 함.

#### 검증

- example.com — a11y 8 refs + vision 6 visual-only ref. paragraph가 viewport 너머로 wrap된 부분 ("without", "needing", "permission.", "Avoid", "use", "in") 만 보강. 첫 줄은 paragraph bbox 안에 contain되어 cover됨. 310ms
- 쿠팡 메인 — visual-only 45개. 주로 광고 배너의 image-as-text ("FORET", "탄라모박가", "AR" 등 — 한국어/영어 혼합). a11y로는 절대 못 잡는 영역
- `--no-cache` + `--vision` 조합도 동작 (vision augment는 console에만)
- 49/49 tests pass (회귀 없음)

#### 한계

- 매 snapshot마다 OCR 추가 비용 (~300ms tesseract / ~3s paddle 첫 실행) — opt-in flag라 default 영향 없음
- 한국어 단음절이 많이 잡힘 (e.g. "탄", "라", "모", "박", "가" 따로) — tesseract의 단어 분할 한계. 라인 단위인 paddle backend가 더 깔끔
- IoU/contain threshold는 페이지 구조에 따라 적절치 다름 — `--vision-iou`/`--vision-contain` 옵션으로 조정
- visual-only ref는 ref-store에 등록 안 됨 (CDP click 불가, 좌표 click 별도 필요) — 현재는 cache emit + LLM 컨텍스트 용도

---

### Phase 6-2c — Florence-2 backend (PR #10, experimental)

#### 의도

Phase 6-2b에서 stub으로 남긴 Florence-2 backend를 `@huggingface/transformers` v4로 실제 구현. vision-language 모델로 OCR + OCR_WITH_REGION + OD + DENSE_REGION_CAPTION 통합 지원이 목표.

#### 구현

`src/vision/backends/florence.ts` — `Florence2ForConditionalGeneration` + `AutoProcessor` + `AutoTokenizer` + `RawImage` 통합. 모델 캐시는 `~/.tirno/models/florence/` (env `TIRNO_MODELS_DIR` override).

env로 제어:
- `TIRNO_FLORENCE_MODEL` (default `onnx-community/Florence-2-base-ft`)
- `TIRNO_FLORENCE_DTYPE` (default `q4` — `fp16`은 onnxruntime graph fusion 버그)
- `TIRNO_FLORENCE_DEBUG=1` — raw decoded text를 stderr로 출력

#### 검증 시도와 한계

1. **fp16 dtype** — onnxruntime init 실패: `SimplifiedLayerNormFusion` graph optimization 충돌 (onnxruntime-node 버전 vs Florence-2 fp16 onnx graph)
2. **q4 dtype** — init 성공, 추론 ~1.5s. 그러나 output 디코딩 깨짐:
   ```
   raw: "</s><s>R_WITH_REGION<poly><loc_0><loc_999>...</s>"
   ```
   - 첫 task token `<OCR_WITH_REGION>`의 `<OC` 부분이 tokenizer 인코딩에서 잘려 `R_WITH_REGION`만 prompt로 들어가는 듯
   - 결과로 `<loc_*>` 토큰만 나오고 실제 텍스트 라벨은 없음
   - `post_process_generation`이 task split 못 해 빈 quad_boxes/labels 반환
3. **q8 dtype** — 동일 증상 (~80s)
4. **`Xenova/Florence-2-base-ft` 변형** — 다운로드 시간 초과 (180s)

#### 현재 상태

- 모델 download / load / generate 인프라 모두 동작
- output 디코딩에 transformers.js v4 + Florence-2 통합 버그
- production용은 **tesseract / paddle 권장**. CLI 사용 시 명시 경고
- 코드는 stub로 되돌리지 않고 유지 — 향후 transformers.js 업그레이드 또는 디코딩 우회 패치 시 즉시 활용 가능
- 49/49 tests pass (회귀 없음)

#### 추정 원인 (향후 디버깅 단서)

- transformers.js v4 tokenizer가 `<OCR_WITH_REGION>` special token을 `<` + `OC` + `R_WITH_REGION` 식으로 분할 인코딩 가능성 → tokenizer config의 added_tokens 점검
- `add_special_tokens=true`로 `tokenizer(TASK)` 강제 시도
- `Florence-2-large` 또는 `microsoft/Florence-2-base` 직접 사용 (transformers.js 호환 onnx 변환 별도)

---

### Phase 6-2b — backend dispatcher + PaddleOCR backend + Florence stub (PR #9)

#### 의도

PR #8에서 tesseract 단일 backend로 시작했으나, 원래 합의(Florence-2 + PaddleOCR onnxruntime)가 손상된 상태였음. 사용자 정정에 따라 **backend interface를 plug-in 구조로 정리하고 PaddleOCR + Florence 추가**. tesseract는 옵션으로 잔류.

#### 구현

- `src/vision/types.ts` (신규) — `OcrBackend` interface, `BackendName` union
- `src/vision/ocr.ts` 재작성 — backend dispatcher. lazy load (사용하지 않는 backend의 native deps는 import 안 됨)
- `src/vision/backends/tesseract.ts` (신규) — 기존 tesseract 로직 분리. `OcrBackend` 구현
- `src/vision/backends/paddle.ts` (신규) — `@gutenye/ocr-node` (onnxruntime-node + sharp 기반 PaddleOCR JS port). 영어 default. 한국어 등은 `--paddle-models <dir>` 옵션으로 모델 path 지정. 입력은 임시 파일 경유 (라이브러리 제약)
- `src/vision/backends/florence.ts` (신규) — stub. 다음 PR에서 `@huggingface/transformers`로 구현. CLI surface는 이번 PR에서 안정화
- `src/commands/vision.ts` — `--backend tesseract|paddle|florence` 옵션 추가. paddle은 `--paddle-models` 추가 옵션
- `package.json` — `@gutenye/ocr-node`, `@huggingface/transformers` dependency. basic-ftp transitive vuln도 동시에 fix

#### 검증

- example.com on tesseract — 19개 단어 95%+ confidence (0.46s 두번째 실행)
- example.com on paddle — 4개 line 100% confidence (2.86s 첫 실행, 모델 로드 포함). `Example Domain`, `Learn more` 등 정확
- 49/49 tests pass (기존 회귀 없음)
- florence backend는 호출 시 명확한 "not implemented" 에러

#### backend별 특성 비교

| backend | 단위 | 한국어 | 첫 실행 | 무게 |
|---|---|---|---|---|
| tesseract | word | ★★ (lang data download) | ~800ms | ~5MB JS + 10MB/lang |
| paddle | line | ★ (default 영어, kor은 모델 별도) | ~2.5s | onnxruntime + sharp + 영어 모델 |
| florence (stub) | TBD | TBD | TBD | TBD (~460MB 예상) |

#### 한계

- paddle 한국어는 모델 별도 download — `--paddle-models <dir>` 옵션으로 지정 (사용자가 PaddleOCR 한국어 det/rec/dict 받아서)
- paddle 입력이 임시 파일 경유 — `@gutenye/ocr-node` v1.4.x 제약. 향후 ImageRaw 직접 전달 가능
- florence backend는 stub — Phase 6-2c
- snapshot 자동 통합(`--vision`)은 별도 PR

---

### Phase 6-2 — vision OCR backend (PR #8)

#### 의도

Phase 6-1의 visual cache는 a11y 트리에 의존. canvas / image-as-text / custom widget 등 a11y가 못 잡는 영역은 빈 채로 둠. OCR backend로 이 빈 영역의 텍스트를 추출 → 향후 cache entry에 visual-only ref로 통합 가능.

#### backend 선정 — Florence-2 + PaddleOCR → tesseract.js로 변경

처음 합의는 Florence-2 + PaddleOCR onnx 결합. 그러나 Node 환경 현실:

- **PaddleOCR onnx direct via onnxruntime-node**: native 의존성 30MB+, preprocessing(image normalize)/postprocessing(DB algorithm + CRNN decoding) 직접 구현 필요 → 큰 PR
- **Florence-2 via transformers.js**: 모델 ~460MB, 영어 중심
- **`@gutenye/ocr-node` (Paddle wrap)**: 한국어 모델 별도 download 필요
- **tesseract.js**: ~5MB JS + lang data download (per lang ~10MB), 한국어/영어 동시 가능, Node에서 안정적, API 단순

**1단계는 tesseract.js로 시작**, backend interface는 plug-in 구조로 잡아두어 PaddleOCR / Florence-2를 추후 옵션으로 추가 가능. 효용성·유지보수성 우선.

#### 구현

- `src/vision/ocr.ts` (신규) — backend-agnostic interface (`OcrResult`, `OcrWord`, `recognize`, `shutdown`). worker는 lang별 lazy + cached → 같은 lang 반복 호출 시 재사용
- `src/cdp/iou.ts` (신규) — `area`, `intersection`, `iou`, `containedIn` 헬퍼. a11y bbox와 vision bbox 매칭에 사용 예정
- `src/commands/vision.ts` (신규) — `vision ocr` 명령
- `package.json` — `tesseract.js` dependency 추가
- `test/iou.test.ts` (신규) — 14 케이스 (area, intersection, iou, containedIn)

#### 검증

- example.com 영어 OCR — 19개 단어, 95%+ confidence, **첫 실행 833ms** (lang data download 포함). 두 번째부터 더 빠름
- google 검색 결과 한국어+영어 OCR (`--lang kor+eng`) — 145개 단어 70%+ confidence, 2260ms. "Google", "이미지", "동영상", "Smasher:Tirno" 등 정상 추출
- bbox + confidence per word 정확
- worker shutdown 동작 (메모리 누수 방지)

#### 한계

- 정확도 PaddleOCR/Florence-2보다 낮음 (특히 작은 글자, 복잡한 레이아웃)
- 페이지 fontconfig/렌더링 차이로 confidence 변동
- a11y bbox와의 IoU 매칭은 helper만 제공, snapshot 통합은 다음 PR
- vision element 자체를 cache entry에 visual-only ref로 저장하는 워크플로우는 다음 PR
- backend interface는 잡았지만 PaddleOCR / Florence-2 실제 plug-in은 향후

---

### 프로덕션 마감 (PR #7)

#### 의도

지금까지의 phase는 기능 추가에 집중. 프로덕션 레벨 효용성·유지보수성을 위해 입구·CI·packaging·테스트 격리를 한 번 정리.

#### 구현

- `README.md` (신규) — 핵심 컨셉, 설치, quick start, 명령 reference, 데이터 위치
- `LICENSE` (신규) — ISC
- `.github/workflows/ci.yml` (신규) — Node 22 / `npm ci` / `npm run build` / `npm test`
- `package.json` 보강 — `keywords`, `files`, `engines`, `repository`, `homepage`, `bugs`, `author`, `license`, `prepublishOnly`
- `src/cdp/element-info.ts` 리팩토링 — page-side 스크립트는 attrs 추출만, selector 결정 로직(`chooseSelector`)을 Node-side 순수 함수로 분리. unit test 가능
- `test/element-info.test.ts` (신규) — `chooseSelector` 12 케이스 (id/data-testid/aria-label/tag[name] 우선순위, special chars, 한글, 따옴표 escape)

#### 검증

- 35/35 unit tests pass (visual-cache 16 + screenshot-hash 7 + element-info 12)
- e2e regression — google.com snapshot에서 selector 추출 정상 (`#ZnpjSd`, `[aria-label="Gmail "]` 등)
- `npm run build` 성공

---

## PR 목록

| # | 제목 (실제 머지 시점 기준) | 상태 |
|---|---|---|
| [#1](https://github.com/Rockheung/tirno/pull/1) | feat: Phase 4 — emulation 영속화 + DPR + ls 가시화 | merged |
| [#2](https://github.com/Rockheung/tirno/pull/2) | feat: Phase 5-1 — a11y @ref + scroll + wait 흡수 | merged |
| [#3](https://github.com/Rockheung/tirno/pull/3) | chore: rename project chromux → wandr | merged |
| [#4](https://github.com/Rockheung/tirno/pull/4) | docs: 작업 일지 + 리서치 문서화 + wandr → tirno rename | merged |
| [#5](https://github.com/Rockheung/tirno/pull/5) | fix: `--enable-automation` flag 제거로 Akamai 봇 차단 우회 | merged |
| [#6](https://github.com/Rockheung/tirno/pull/6) | feat: Phase 6-1 — URL-keyed visual cache + node:test | merged |
| [#7](https://github.com/Rockheung/tirno/pull/7) | chore: 프로덕션 마감 — README + packaging + element-info 격리 | merged |
| [#8](https://github.com/Rockheung/tirno/pull/8) | feat: Phase 6-2 — vision OCR backend (tesseract.js) + IoU helper | merged |
| [#9](https://github.com/Rockheung/tirno/pull/9) | feat: Phase 6-2b — backend dispatcher + PaddleOCR backend + Florence stub | merged |
| [#10](https://github.com/Rockheung/tirno/pull/10) | feat: Phase 6-2c — Florence-2 backend (experimental, output decoding 한계) | merged |
| [#11](https://github.com/Rockheung/tirno/pull/11) | feat: Phase 6-2d — snapshot --vision 통합 (a11y 못 잡은 영역 OCR로 보강) | merged |
| [#12](https://github.com/Rockheung/tirno/pull/12) | feat: Phase 6-1b — viewport-aware visual cache | merged |
| [#13](https://github.com/Rockheung/tirno/pull/13) | fix: commander coercer로 parseInt/parseFloat 직접 사용 시 NaN 버그 (13곳) | merged |
| [#14](https://github.com/Rockheung/tirno/pull/14) | feat: Phase 6-2e — backend 분류 (local/cloud) + cloud backend stubs + default paddle | merged |
| [#15](https://github.com/Rockheung/tirno/pull/15) | feat: default viewport + 작업 원칙 + raw CDP + dialog 우회 + drag | merged |
| [#16](https://github.com/Rockheung/tirno/pull/16) | feat: record/replay — 사용자 행동 캡처 + raw CDP 재현 | merged |
| [#17](https://github.com/Rockheung/tirno/pull/17) | chore: tesseract 제거 + eslint 설정 | merged |
| [#18](https://github.com/Rockheung/tirno/pull/18) | feat: sandweb wishes (A/B/C/D/E/F) — 재실행 갱신, --url, ls flags, --strict, ephemeral, group | open |

## 보류된 항목 (다음 phase 후보)

- **agent self-journaling 메모리 레이어** — 사용자가 가장 관심 있어한 방향. agent의 시행착오를 자동 누적/재호출 (Level 1: append-only journal → Level 4: memory-augmented agent)
- **emulate `--reset` 시 touch 미해제** — puppeteer 24 안정 API 한계
- **`console` 명령 stateless 한계** — daemon 없이 메시지 캡처 불가
- **vision segmentation 통합** — annotated screenshot 위에 OmniParser/SAM2 등 결과를 더해 visual-only 영역(canvas, custom widget) 학습
