# 리서치

## 비슷한 목적의 도구들

### 핵심 비교 — tirno vs yansfil/chromux vs vercel/agent-browser

| 항목 | tirno (rockheung) | yansfil/chromux | vercel-labs/agent-browser |
|---|---|---|---|
| 활성도 | 활발 | 1회 publish (2026-03) 정지 | 매우 활발 (0.26.0, 2026-04-16) |
| 언어 | TS + puppeteer-core | JS + zero-dep raw CDP | **Rust 네이티브** |
| 명령 수 | **66** (`tirno schema` 로 실측) | ~15 | **50+** |
| a11y @ref | ✅ | ✅ | ✅ + **annotated screenshot** |
| find by role/text | — | — | ✅ |
| daemon | — | ✅ | ✅ |
| multi-instance | ✅ session | ✅ profile | ✅ (auth 분리) |
| Engine | Chrome | Chrome | Chrome / lightpanda |
| device emulation | ✅ (device/network/cpu/dpr) | — | ✅ (set device/viewport/geo/offline/headers/credentials/media) |
| performance trace / heap | ✅ | — | ✅ trace + 별도 profiler |
| visual diff | ✅ | — | ✅ (snapshot/screenshot/url 3종) |
| broadcast (다세션 동시) | ✅ | — | — (`batch`는 한 세션 내 순차) |
| AI agent 친화 출력 | 일반 | a11y @ref | **token-efficient compact** |
| 공식 통합 | — | — | Claude Code/Cursor/Copilot/Codex 명시 |
| 자체 메모리/학습 | ❌ | ❌ | ❌ (skills은 정적 markdown) |

### tirno 의 차별 영역

- **broadcast** — 다세션 동시 푸시. agent-browser는 single-session per command. tmux 스타일로 *동시에 여러 Chrome instance에 같은 명령*은 tirno 만의 영역
- 그 외 emulate/diff/perf는 agent-browser에 동등하거나 우수하게 구현됨

### agent-browser의 추가 강점 (tirno 미보유)

- `set credentials` (HTTP auth)
- `set offline on/off`
- `set media dark` / `reduced-motion`
- `mouse move/down/up/wheel` 정밀 제어
- `record start/stop` (WebM 비디오)
- `stream enable` (runtime WebSocket streaming)
- `auth save/login/list` (auth vault, 암호화)
- `clipboard` / `inspect` (DevTools open) / `highlight`
- `find role button --name "Submit"` 같은 high-level locator
- `connect <port|url>` (외부 Chrome 인스턴스 attach)
- `--json` 글로벌 (machine-readable)
- skills 시스템 (`agent-browser skills get core --full`)
- `pdf <path>`
- HAR 캡처 (`network har start/stop`)
- Network mocking (`network route/unroute`)

---

## 그 외 비슷한 도구들

### CLI / Lightweight wrapper

- **agent-browser** (Vercel Labs) — Rust CLI, a11y refs, skills, multi-cloud, Gateway 통합 chat
- **firecrawl-cli** — TS CLI, Playwright 기반, AI agent skill로 자동 등록
- **chrome-cdp-skill** (pasky) — Claude skill 형식. 이미 떠있는 사용자 Chrome에 attach
- **Tappi** — Python 라이트 CDP wrapper + 자체 agent
- **chromux** (yansfil) — JS CLI, zero-dep raw CDP

### Full agentic framework

- **browser-use** (Python) — **WebVoyager 89.1%**. agent-first 자율 reasoning loop. 최근 Playwright → 직접 CDP로 마이그레이션
- **Stagehand** (Browserbase TS) — Playwright extension. 기본은 deterministic 코드, 막힐 때만 `act/extract/observe` AI helper
- **Skyvern** (Python) — LLM + computer vision + Playwright SDK + 노코드 워크플로 빌더
- **browser-harness** (browser-use 별도 프로젝트) — self-healing CDP harness. LLM이 missing function을 런타임에 작성

### Browser extension

- **Nanobrowser** — Chrome 확장. OpenAI Operator의 무료 alternative. 사용자 API key (Anthropic/OpenAI/Google) 직접 사용 가능

### MCP server

- **Playwright MCP** (Microsoft) — Playwright + MCP. a11y snapshot 기반. 외부 LLM이 MCP 프로토콜로 호출

### 클라우드 브라우저

- **Browserbase / Browserless / Cloudflare Browser Run / Browser Use Cloud / AWS Bedrock AgentCore / Kernel** — agent-browser가 multi-provider로 통합하는 백엔드들

### Native 엔진

- **Lightpanda** (Zig) — CDP 호환 네이티브 브라우저. `Accessibility.getFullAXTree` 표준 지원. agent-browser의 `--engine lightpanda`가 호출

---

## 4가지 철학 분기점

| 차원 | 양극 |
|---|---|
| **Determinism** | Stagehand(deterministic-first) ↔ browser-use(autonomous reasoning) |
| **Page representation** | a11y tree (agent-browser/Playwright MCP) ↔ vision (Skyvern) ↔ DOM (Nanobrowser) |
| **LLM coupling** | 자체 chat 내장 (agent-browser, browser-use) ↔ MCP 프로토콜 분리 (Playwright MCP) ↔ 사용자 wrapper (Tappi, chrome-cdp-skill) |
| **Distribution** | CLI binary (agent-browser) ↔ library (Stagehand, browser-use) ↔ extension (Nanobrowser) ↔ cloud SaaS (Browserbase, Skyvern) |

---

## agent-browser의 지식 누적 메커니즘 (현황)

자체 학습은 없음. 디스크에 보존되는 세 층:

1. **정적 가이드 (skills)** — vendor 배포. `agent-browser skills get core` 등으로 stdout에 emit. 바이너리에 동봉, 버전 업그레이드로만 갱신. `AGENT_BROWSER_SKILLS_DIR` 환경변수로 사용자 디렉토리 override 가능 → 자체 도메인 skill 추가 표준 진입점
2. **운영 상태** — `~/.agent-browser/` (daemon, 메타), Chrome user-data-dir (cookies/storage), `auth save` 암호화 vault
3. **단명 상태** — `@eN` ref 매핑 (snapshot마다 재할당, 페이지 변경 시 즉시 stale), chat REPL conversation

즉 ab는 의도적으로 "stateless agent에게 page 상태만 깨끗하게 노출" — 학습은 LLM/사용자 측에 위임.

### 기능 학습이 가능한 길

- **자체 skill markdown 작성** — `~/skills/<site>.md` 만들고 `AGENT_BROWSER_SKILLS_DIR=~/skills` 설정. LLM이 매 호출에서 `skills get <site>`로 컨텍스트 로드
- **`auth save` profile** — `--username-selector` / `--password-selector` / `--submit-selector` 저장 → 다음 호출 자동 fill
- **batch script** — 반복 시퀀스 .txt/.json 저장 후 재실행
- **snapshot/screenshot baseline** — `diff snapshot --baseline` 으로 regression 감지

이 모두 **사람이 markdown으로 코드화**하는 형태. agent가 스스로 누적하는 메커니즘은 없음.

---

## Vision segmentation 학습 영역 설계

annotated screenshot이 a11y refs 위에 numbered 라벨을 그려 — Set-of-Mark 형식 그대로. vision-only 영역(canvas/custom widget/iframe/shadow DOM 안)을 보강하려면:

### 데이터 흐름

```
screenshot → segmentation → DOM bbox 매칭 → segment-store 누적
                                                ↓
                                          skill에 inject
                                                ↓
                                          LLM 컨텍스트
```

### 단계

1. **입력 수집** — `screenshot --full` + `get box <selector>` 또는 직접 `Elements.boundingBoxes`. ab는 이미 `screenshot --annotate`로 Set-of-Mark 출력 가능
2. **Segmentation** — 로컬 OmniParser/SAM2/Florence-2/YOLO-UI, 또는 자체 segment 서버 (FastAPI + 모델). 결과: `[(bbox, role, label, confidence, visual_fp)]`
3. **DOM ↔ Visual 매핑** — vision bbox와 DOM bbox를 IoU 매칭. iframe/shadow DOM/canvas 안은 visual-only로 남김
4. **누적**:
   - (a) skill에 inject — `~/skills/<site>.md`에 segment dictionary 자동 생성, LLM이 매 호출에서 emit
   - (b) 외부 segment store — `~/.segments/<site>.json` + URL/visual_fp 인덱스, 별도 lookup 명령

### 점진적 학습

- 페이지 visual hash가 동일하면 cached segment 재사용
- 다르면 diff 영역만 재segment → store 갱신
- selector × role/label 일관성으로 confidence 누적

### 트레이드오프

| 문제 | 영향 | 완화 |
|---|---|---|
| layout 변경 시 stale | 좌표·selector 무효 | visual_fp + selector 다중 키 |
| vision 비용 | 100~500ms (로컬 GPU) / 외부 API 과금 | fingerprint 캐시 + change detection |
| canvas/webgl/shadow DOM | DOM 매핑 실패 | visual-only segment + click(coordinate) |
| privacy | 외부 API에 screenshot 송신 | 로컬 모델 우선, 민감 사이트 force-local |
| 토큰 비용 | skill 길어지면 매 호출 누적 | top-N + 압축 형식 |

---

## agent self-journaling niche

**기존 도구 어디에도 없는 영역** — agent가 시행착오로 알아낸 사실을 자동 기록 → 다음 시도 시 재사용. browser-use는 한 session 내 history만 있고, ab의 skills는 정적 markdown(사람 작성). 이 영역이 비어있는 것이 tirno이 가질 수 있는 진짜 차별점.

### 누적 메커니즘 패턴 (가벼운 → 무거운)

#### Level 1 — append-only journal (PoC 가능)

```
~/.tirno/notes/<site>.md
```

- task 시작: `tirno notes load example.com` → stdout에 이전 노트 emit → LLM 컨텍스트로 주입
- task 종료: agent가 LLM 호출로 "이번에 알게 된 것 한 줄로 적어" → `tirno notes append example.com "<line>"`
- 한 줄당 timestamp + 카테고리 (`SELECTOR / PITFALL / WORKFLOW / ERROR`)
- 비대해지면 LLM이 `tirno notes compact <site>`로 요약/중복 제거

#### Level 2 — episodic store

```
~/.tirno/episodes/<site>.jsonl
{ ts, goal, steps: [{cmd, ok, extract}], outcome, lessons: [...] }
```

- 매 episode 종료 시 LLM이 lessons 추출
- 다음 task: goal 임베딩 → nearest episodes 검색 → top-k의 lessons + steps을 컨텍스트
- vector index (SQLite + sqlite-vss / Chroma / lance)로 retrieval

#### Level 3 — skill library (Voyager 패러다임 web 이식)

- 성공한 (goal → command sequence) 쌍을 reusable skill로 저장
- 새 task가 오면 LLM이 기존 skill 중 hit 여부 판단 → 즉시 호출 / 부분 활용 / 새로 작성
- 새로 작성한 것도 검증 후 라이브러리에 자동 추가
- Minecraft Voyager의 web 영역 이식

#### Level 4 — full memory-augmented agent

- Mem0 / Letta / MemGPT / Zep 같은 메모리 인프라 통합
- short-term(이번 session), long-term(전체 사이트), reflective(주기적 요약) 분리
- Letta는 정확히 이 패턴을 라이브러리로 제공 (다만 web 자동화 특화 아님)

### 즉시 시도 가능한 PoC (Level 1)

```
tirno notes load <site>             # 이전 lessons + selector hints 출력
tirno notes append <site> <kind> <text>
tirno notes compact <site>          # LLM으로 요약/중복 제거
tirno notes search "login button"   # full-text 또는 임베딩
```

agent의 task 시작 step 1과 종료 step N에 위 두 명령만 끼우면 즉시 가치 발생. 그 위에 episode JSONL → vector index 순으로 키울 수 있음.

---

## Vercel AI Gateway 이슈

agent-browser `chat`은 **Vercel AI Gateway 전용**:

- chat help: *"Requires AI_GATEWAY_API_KEY to be set"*
- 환경변수: `AI_GATEWAY_API_KEY` (필수), `AI_GATEWAY_MODEL` (default 모델)
- `--model anthropic/claude-sonnet-4.6` 같은 표기는 Gateway **위에서** 모델을 라우팅할 뿐, 실제 호출은 Gateway 통과
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` 등 직접 vendor 키는 **인식 안 됨**

### 우회

- Vercel AI Gateway 키 발급 (무료 티어)
- chat 명령 안 쓰고 외부에서 agentic loop 구성 — 본인 Anthropic 키로 직접 SDK 호출 → 응답에서 명령 추출 → `agent-browser <cmd>` 실행

---

## host-resolver-rules 같은 Chrome flag 전달

| 도구 | 방법 | 메모 |
|---|---|---|
| **tirno** | `tirno new test -- --host-resolver-rules="..."` | commander의 `--` 이후 raw argv. 가장 깔끔 |
| **agent-browser** | `--args "--host-resolver-rules=..."` 또는 `AGENT_BROWSER_ARGS` env | comma split이 host-resolver-rules의 쉼표와 충돌 가능 → newline 또는 env 사용 |
| **agent-browser (외부 Chrome attach)** | `chrome --remote-debugging-port=9222 --host-resolver-rules="..."` 후 `agent-browser connect 9222` | 어떤 chrome flag든 가능 |

---

## 참고 자료

- [agent-browser on npm](https://www.npmjs.com/package/agent-browser)
- [vercel-labs/agent-browser on GitHub](https://github.com/vercel-labs/agent-browser)
- [agent-browser SKILL.md](https://github.com/vercel-labs/agent-browser/blob/main/skills/agent-browser/SKILL.md)
- [agent-browser.dev](https://agent-browser.dev/)
- [browser-use/browser-use](https://github.com/browser-use/browser-use)
- [Closer to the Metal: Leaving Playwright for CDP — browser-use](https://browser-use.com/posts/playwright-to-cdp)
- [Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern)
- [nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser)
- [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)
- [browser-use/browser-harness](https://github.com/browser-use/browser-harness)
- [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill)
- [shaihazher/tappi](https://github.com/shaihazher/tappi)
- [Lightpanda — Markdown and AXTree docs](https://lightpanda.io/docs/open-source/guides/markdown-axtree)
- [steel-dev/awesome-web-agents](https://github.com/steel-dev/awesome-web-agents)
- [Browser Use vs Stagehand comparison — Skyvern](https://www.skyvern.com/blog/browser-use-vs-stagehand-which-is-better/)
- [Best Browser Agents 2026 — Firecrawl](https://www.firecrawl.dev/blog/best-browser-agents)

---

## 2026-08-18 재조사 — CLI + 스킬로 Chrome 을 부리는 흐름

> **근거 수준 주의.** tirno 는 소스를 읽고 실행해 확인했고, 아래 도구들은 **README 수준**에서만
> 확인했다. 비대칭이 비교를 tirno 에 유리하게 기울인다 — 남의 도구는 광고하는 것만,
> tirno 는 약점까지 보이기 때문이다.

"별도 브라우저를 만들지 않고 얇은 CLI + 스킬로 진짜 Chrome 을 CDP 로 부린다"는 발상은
이제 붐빈다. MCP 대신 CLI 를 고른 것도 tirno 만의 선택이 아니다.

| 도구 | 인터페이스 | 붙기/띄우기 | 격리 단위 | 런타임 |
|---|---|---|---|---|
| **tirno** | CLI + 스킬 | 띄운다 | 프로세스(세션) | Node + 무거운 deps |
| [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) | CLI + 스킬 | **붙기만** | 탭당 상주 데몬 | **Node 22, 설치 0** |
| [pengelbrecht/chrome-debug-skill](https://github.com/pengelbrecht/chrome-debug-skill) | CLI + 스킬 | 띄운다 | 포트+프로필 | Python 단일파일(uv), macOS 전용 |
| [shaun0927/openchrome](https://github.com/shaun0927/openchrome) | MCP + CLI | 붙는다 | **탭 20레인 ~300MB** | Node |
| [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | MCP | 둘 다 | 프로필(`--isolated`) | Node |

### tirno 가 혼자인 것

- **소유권 판정** — pid+port+profile 3중 일치. 어느 도구에도 대응물이 없다.
  chrome-debug-skill 의 `stop` 은 "프로필 경로가 맞는 것 전부"를 죽인다.
- **drift** — 선언 대비 실행 중 프로세스 비교. 없다.
- **`gc`** — 장부만 지우고 프로필은 지킨다. 없다.
- **`stall`** — 렌더러 밖에서 메인스레드 포화 측정. 없다.

### tirno 가 지는 것

- **설치 비용** — chrome-cdp-skill 은 Node 22 하나에 `npm install` 조차 없다.
  tirno 는 lancedb·transformers·lighthouse 에 네이티브 바이너리까지 끌고 온다.
- **연결 모델** — chrome-cdp-skill 은 탭당 상주 데몬이라 재연결 비용이 없다.
  tirno 는 one-shot 이라 명령마다 붙는다(실측 0.1~0.3s).
- **병렬 비용** — OpenChrome 은 한 Chrome 에 20레인. tirno 는 세션 = 프로세스다.
  다만 이건 트레이드오프다 — 세션별 `--host-resolver-rules`·프록시·프로필 격리는
  탭으로는 안 된다.
- **복구 지능** — OpenChrome 의 7단계 폭포(a11y → CSS → 좌표 → JS → 키보드 → raw 마우스
  → 사람)와 3층 서킷브레이커가 tirno 의 multi-channel fallback 보다 구체적이다.
- **표면적** — chrome-devtools-mcp 는 59 tool. 힙 13종·PWA·확장까지 있다.

### chrome-devtools-mcp 를 의존성으로 삼지 않는 이유

Chrome DevTools 팀의 공식 MCP 다. 통째로 안는 대신 **앵커로 합성한다**:

```bash
npx chrome-devtools-mcp --auto-connect --user-data-dir=~/.tirno/anchors/main
```

- **소유권이 뒤집힌다.** 그쪽은 자기가 말 거는 브라우저를 자기가 소유하려 한다(직접 띄우고
  `~/.cache/chrome-devtools-mcp/chrome-profile` 에 자기 프로필을 둔다). 한 브라우저에 주인이
  둘이면 그게 바로 `inventory.ts` 가 `ambiguous` 로 잡아 손대기를 거부하는 상태다.
- **모양이 안 맞는다.** MCP 응답은 LLM 이 읽으라고 토큰 최적화된 텍스트다. 가치 흐름 1번은
  구조화된 데이터를 ms 단위로 요구한다.
- **Chrome 에 용접된다.** 힙·PWA·확장은 본성상 Chrome 전용이라, 받아들일수록
  [multi-browser](./research-multi-browser.md) 추상화의 부채가 된다.
- **비용.** one-shot CLI 가 명령마다 Node 서브프로세스와 JSON-RPC 핸드셰이크를 치른다.

앵커로 합성하면 사용자는 59 tool 과 tirno 의 세션 층을 동시에 갖고, 둘 중 누구도 상대를
소유하지 않는다.
