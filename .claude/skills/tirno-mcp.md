---
description: chrome-devtools-mcp 의 모든 tool 에 대응하는 tirno CLI 사용법 매뉴얼. 브라우저 자동화 / 스크래핑 / 디버깅 / lighthouse audit / 트레이스 / 메모리 분석 / 화면 녹화. 미구현 영역은 명시. (chrome-devtools-mcp 의 list_pages / click / fill / take_screenshot / lighthouse_audit 등을 호출하려는 의도가 보이면 이 skill 을 참고)
---

# tirno CLI ↔ chrome-devtools-mcp 1:1 매핑

이 skill 은 chrome-devtools-mcp 의 45+ tool 각각에 대해 동등한 `tirno` CLI 사용법을 제공한다. 사용자가 chrome-devtools-mcp tool 을 호출하려는 의도를 보이면, 이 매뉴얼을 참고해 `tirno` CLI 로 대체 실행한다.

> 기본 tirno 사용법(세션 관리, 포트, 메타데이터 등)은 `/tirno` skill 참고. 본 skill 은 chrome-devtools-mcp 매핑에 집중.

## 일반 원칙

- tirno 는 multi-session — 먼저 `tirno new <name> [url]` 로 세션을 띄우고, 이후 모든 명령은 active 세션에 작용한다. 명시 세션은 `--session <name>` 또는 `-s <name>`.
- **mcp 와 tirno 를 같이 쓸 거면 mcp 를 포트가 아니라 디렉토리에 물린다.** `npx chrome-devtools-mcp --auto-connect --user-data-dir=~/.tirno/anchors/main` 로 한 번 설정해 두면, tirno 가 Chrome 을 재기동해 포트가 바뀌어도 mcp 가 다음 tool 호출에서 알아서 따라온다(연결마다 `<dir>/DevToolsActivePort` 를 다시 읽는다). 앵커 조작은 `tirno anchor set/ls/rm`. 자세한 것은 `/tirno` skill 의 "앵커" 절.
- **`--browser-url http://127.0.0.1:9222` 방식은 쓰지 않는다.** 9222+ 는 공용 대역이라 남의 앱이 점유하고 있어도 포트 번호만 맞으면 붙는다 — 프로덕션 DB 프록시 탭을 쥔 Electron 앱에 CDP 제어권을 넘긴 사고가 실제로 이 경로였다. 앵커 방식은 ws 경로의 browser UUID 가 인스턴스를 식별해 남의 브라우저에는 404 로 튕긴다.
- snapshot 의 `@N` ref 가 mcp 의 `uid` 와 동등 — `tirno snapshot` 후 즉시 `tirno click @5` 처럼 사용 가능. snapshot 출력이 새로 갱신되면 이전 ref 는 stale.
- chrome 를 띄우는 명령(`tirno new`, `tirno restart`)은 Bash 호출 시 timeout 10s 이상 명시.
- 직접 매핑이 없으면 `tirno cdp <method> [params-json]` 로 raw CDP passthrough — 거의 모든 mcp tool 의 fallback 경로.
- `tirno cdp --browser <method>` 로 browser-level CDP 도메인(`Target.*`, `Browser.*`, `Tracing.*`).

## 카테고리별 매핑 표

### Navigation

| mcp tool | tirno 명령 | 비고 |
|---|---|---|
| `list_pages` | `tirno pages` | ID/title/URL 테이블, `--json` 가능 |
| `select_page` | `tirno select <id>` | ID 는 `tirno pages` 의 안정 핸들(CDP targetId 앞 8자리). 위치 인덱스가 아니라 탭이 열리고 닫혀도 안 바뀐다 |
| `close_page` | `tirno close-tab <id>` | — |
| `new_page` | `tirno new-tab <url>` 또는 `tirno new <name> <url>` | 새 탭(같은 세션) vs 새 세션 — 의도에 맞게 |
| `navigate_page type=url` | `tirno nav <url>` | — |
| `navigate_page type=back` | `tirno back` | history 없으면 명확한 에러 |
| `navigate_page type=forward` | `tirno forward` | — |
| `navigate_page type=reload` | `tirno reload` | `--ignore-cache` 는 `tirno cdp Page.reload '{"ignoreCache":true}'` |
| `navigate_page initScript` | **미구현 직접 옵션** — `tirno cdp Page.addScriptToEvaluateOnNewDocument '{"source":"..."}'` 후 `tirno nav` | — |
| `wait_for` (selector) | `tirno wait-for <selector> --timeout <ms>` | — |
| `wait_for` (text) | `tirno wait-for --text "<a,b,c>" --timeout <ms>` | comma 구분 any-of |
| `wait_for` network idle | `tirno wait-for --network-idle` | — |
| `get_tab_id` (실험적) | **미구현 직접 명령** — `tirno pages` 의 ID 칼럼 사용 | 또는 `tirno cdp Target.getTargets` |

### Input

| mcp tool | tirno 명령 | 비고 |
|---|---|---|
| `click` (uid) | `tirno click @N` 또는 `tirno click <css>` | snapshot 후 ref 또는 selector |
| `click` (dblClick) | **미구현 직접 옵션** — `tirno cdp Input.dispatchMouseEvent` 두 번 또는 `tirno eval "el.click(); el.click()"` | — |
| `click_at` (x,y) | `tirno click "<x>,<y>" [--dbl]` | wave 4 — 좌표 형태면 자동으로 `Input.dispatchMouseEvent` trusted click 사용 |
| `hover` | `tirno hover <selector>` | — |
| `fill` (input/textarea) | `tirno fill <target> <value>` | target = selector or @ref |
| `fill` (checkbox/select 자동) | **부분 매핑** — selector 가 select 이면 `tirno eval "document.querySelector('#s').value='b'"`, checkbox 는 `tirno click` | mcp 의 자동 분기 동등 미구현 |
| `type_text` | `tirno type "<text>"` (+ `tirno press Enter` for submitKey) | — |
| `drag` (uid → uid) | `tirno drag <from> <to>` | selector 또는 "x,y" 좌표 |
| `fill_form` (배치) | `tirno fill --batch '[{"target":"#a","value":"x"},...]'` | 단일 호출 다중 필드 |
| `upload_file` | `tirno upload <selector> <files...>` | DOM.setFileInputFiles |
| `press_key` (chord) | `tirno press <key>` | 예: `Enter`, `Tab`, `Control+A` |
| `handle_dialog` | (자동 dismiss) — 명시 accept/dismiss 는 `tirno cdp Page.handleJavaScriptDialog '{"accept":true,"promptText":"..."}'` | tirno 는 default 로 dialog 우회 |

### Emulation

| mcp tool | tirno 명령 | 비고 |
|---|---|---|
| `emulate networkConditions` | `tirno emulate --network <slow-3g\|fast-3g\|4g\|offline>` | — |
| `emulate cpuThrottlingRate` | `tirno emulate --cpu <rate>` | 1~20 |
| `emulate viewport` | `tirno emulate --viewport <w>x<h> [--dpr <n>]` | — |
| `emulate userAgent` | `tirno emulate --user-agent "<ua>"` | 빈 문자열 = clear |
| `emulate colorScheme` | `tirno emulate --color-scheme <light\|dark\|no-preference>` | — |
| `emulate geolocation` | `tirno emulate --geolocation "<lat>,<lng>" [--geolocation-accuracy <m>]` | 권한 grant 자동 (`browserContext.overridePermissions`) |
| `emulate device preset` | `tirno emulate --device "<name>"` | mcp 에 없는 편의 — UA+viewport+dpr 일괄. 목록은 `--list-devices` |
| `resize_page` | `tirno emulate --viewport <w>x<h>` | — |
| (전체 reset) | `tirno emulate --reset` | — |

### Network

| mcp tool | tirno 명령 | 비고 |
|---|---|---|
| `list_network_requests` | `tirno network [--type <type>] [--limit <n>]` | reload 후 캡처 |
| `list_network_requests` (JSON) | `tirno network --json` | id/headers 포함 |
| `get_network_request` (header + body) | `tirno network --show <id>` | `Network.getResponseBody` 포함, base64 여부 표시 |
| (resource type 필터) | `tirno network --type <document\|xhr\|fetch\|...>` | — |

### Performance

| mcp tool | tirno 명령 | 비고 |
|---|---|---|
| `performance_start_trace` (+ auto-stop) | `tirno trace --duration <s> --out <path>` | one-shot, fixed duration |
| `performance_start_trace` (manual stop) | `tirno trace start [path]` | wave 4 — detached worker 가 trace 보유 |
| `performance_stop_trace` | `tirno trace stop <path>` | wave 4 — SIGTERM 으로 finalize, 결과 파일 검증 후 `trace insight` 안내 |
| `performance_analyze_insight` | `tirno trace insight <path>` | LCP / FCP / DCL / load / CLS / long tasks. `--json` 가능 |

### Debugging

| mcp tool | tirno 명령 | 비고 |
|---|---|---|
| `list_console_messages` | `tirno console [--reload] [--type log\|error\|warn] [--ms <n>]` | tirno 는 one-shot — page-load 메시지를 잡으려면 `--reload` |
| `get_console_message` (단건) | `tirno console --reload --show <id>` | args/location/stackFrames JSON |
| `take_screenshot` | `tirno screenshot --out <path> [--full] [--format png\|jpeg\|webp]` | element-only 는 `tirno cdp Page.captureScreenshot` 좌표 또는 element bbox 잘라내기 |
| `take_snapshot` (a11y) | `tirno snapshot` | `@N` uid 매겨짐 — 이후 click/fill 에 사용 |
| `screencast_start` | `tirno screencast start [--out <dir>] [--format png\|jpeg] [--every-nth <n>] [--max-width <px>]` | detached worker 가 frame 캡처. headless 는 frame 적게 잡힘 |
| `screencast_stop` | `tirno screencast stop --out <dir>` | SIGTERM, index.json finalize. ffmpeg stitch 명령은 출력에 안내 |
| `evaluate_script` (function + uid args) | `tirno eval "<expression>"` | 함수 + element handle args 형식은 미지원 — `(() => { const el = document.querySelector('...'); ... })()` 같은 expression 으로 inline |
| `lighthouse_audit` | `tirno audit [url] [--mode navigation\|snapshot] [--device desktop\|mobile] [--categories <a,b,c>] [--out <html>] [--json <json>]` | 활성 세션의 chrome 재사용 — 세션 캐시/로그인 보존 |
| `lighthouse_audit timespan` | **미구현** — split start/stop daemon 필요 | navigation/snapshot 만 |

### Memory

| mcp tool | tirno 명령 | 비고 |
|---|---|---|
| `take_memory_snapshot` | `tirno memory --out <path>` | .heapsnapshot 저장 |
| `load_memory_snapshot` | `tirno memory load <path>` | totalSize / nodeCount / strings 등 summary |
| `get_memory_snapshot_details` | `tirno memory details <path> [--page-size <n>] [--page-idx <n>]` | type/object name 별 aggregate (count + size), 페이지네이션 |
| `get_nodes_by_class` | `tirno memory details` 결과의 type+name 보조 사용 | **부분 매핑** — class UID 별 instance 추적은 미구현 |

### Extensions (chrome-devtools-mcp default off)

| mcp tool | tirno 명령 | 비고 |
|---|---|---|
| `install_extension` | **미구현 직접 명령** — `tirno cdp Extensions.loadUnpacked '{"path":"..."}'` | — |
| `uninstall_extension` | **미구현 직접 명령** — `tirno cdp Extensions.uninstall '{"id":"..."}'` | — |
| `list_extensions` | **미구현 직접 명령** — `tirno cdp Extensions.getStorageItems` 등 raw | — |
| `reload_extension` | **미구현 직접 명령** — raw CDP | — |
| `trigger_extension_action` | **미구현 직접 명령** — raw CDP | — |

### Third-Party / WebMCP (실험적, 사용 빈도 낮음)

| mcp tool | tirno 명령 | 비고 |
|---|---|---|
| `list_3p_developer_tools` | **미구현** — `tirno eval "Object.keys(window.__dtmcp ?? {})"` 로 우회 | — |
| `execute_3p_developer_tool` | **미구현** — `tirno eval "window.__dtmcp[name](params)"` 로 우회 | — |
| `list_webmcp_tools` | **미구현** | — |
| `execute_webmcp_tool` | **미구현** | — |

### Slim build (3 tools, mcp `--slim` 모드)

| mcp slim | tirno |
|---|---|
| `screenshot` | `tirno screenshot --out <path>` |
| `navigate` (URL only) | `tirno nav <url>` |
| `evaluate` (expression) | `tirno eval "<expression>"` |

---

## tirno 만의 추가 surface (mcp 에 없음)

다음은 mcp 에 매핑이 없지만 tirno 에서만 제공하는 고유 기능. 작업 흐름에 적극 활용:

- `tirno new <name> [url]` / `tirno restart` / `tirno ls` / `tirno attach` / `tirno kill` — 다세션 관리. `tirno ls` 의 `OWNER` 는 장부가 아니라 관측(`ours|foreign|ambiguous|ghost`)이고, `kill` 은 `foreign`/`ambiguous` 를 거부한다
- `tirno anchor ls/set/rm` — 브라우저 MCP 가 물릴 디렉토리 앵커. `--evict` 로 이전 브라우저를 같이 정리해 붙어 있던 MCP 를 새 쪽으로 재연결시킨다
- `tirno gc [--dry-run] [--older-than <days>]` — 낡은 장부·잔존 `DevToolsActivePort` 정리. 브라우저는 절대 죽이지 않고, 앵커·active·살아있는 프로필은 남긴다
- `tirno drift [name] [-- <flags>]` — 선언한 chrome 플래그와 실행 중 프로세스 비교. `--host-resolver-rules` 처럼 기동 때 한 번만 읽는 플래그를 바꿨을 때 "이 세션 재기동 필요한가"에 답한다. 다르면 non-zero 로 끝나므로 스크립트에서 조건으로 쓸 수 있다
- `tirno cdp <method> [params-json]` — 모든 CDP 명령 raw passthrough (`--browser` flag 로 browser-level 도메인)
- `tirno cache list/load/prune` — URL/viewport 키 visual cache
- `tirno schema [--pretty]` — 명령 트리 전체를 JSON 으로. mcp 는 tool 스키마를 프로토콜이
  주지만 CLI 에는 그런 층이 없어서 만든 것이다. 엔드포인트마다 `effects`(read_only /
  idempotent / non_idempotent)와 `destructive` 를 달고 나오므로, **실행 전에** 되돌릴 수
  없는 명령인지 판정할 수 있다. `-- <chrome flags>` 를 받는 명령은 `passthrough` 로 표시된다
- `tirno record start/stop` + `tirno replay <name>` — 사용자 행동 캡처 + raw CDP trusted events 로 재생 (multi-channel fallback: dom → a11y → bbox → coords)
- `tirno trail capture/save/list/show/replay/rm` — goal 별 다단계 행동 시퀀스 (multi-channel fallback)
- `tirno broadcast <cmd> [args...]` — 다세션 동시 실행
- `tirno diff <s1> <s2>` — 두 세션 visual diff (pixelmatch)
- `tirno stats` — `~/.tirno/metrics.jsonl` 집계 (cache hit, llm cost, trail success rate 등)

---

## 워크플로 예시

### 1. 페이지 로드 + 폼 입력 + 캡처
```bash
tirno new work https://example.com/login --headless --ephemeral
tirno snapshot                     # @1..@N uid 확인
tirno fill --batch '[{"target":"@3","value":"user@a.com"},{"target":"@4","value":"pw123"}]'
tirno click @5                     # 로그인 버튼
tirno wait-for --text "로그인 완료" --timeout 5000
tirno screenshot --out /tmp/done.png
tirno kill work --clean
```

### 2. 성능 audit
```bash
tirno new perf https://example.com --headless --ephemeral
tirno trace --duration 5 --out /tmp/t.json
tirno trace insight /tmp/t.json   # LCP/FCP/CLS
tirno audit https://example.com --out /tmp/lh.html
tirno kill perf --clean
```

### 3. 메모리 분석
```bash
tirno new mem https://example.com --headless --ephemeral
tirno memory --out /tmp/h.heapsnapshot
tirno memory load /tmp/h.heapsnapshot
tirno memory details /tmp/h.heapsnapshot --page-size 30
tirno kill mem --clean
```

### 4. 화면 녹화
```bash
tirno new cast https://example.com --ephemeral   # 헤드리스 X — 실제 repaint 가 있어야 frame 잡힘
tirno screencast start --out /tmp/cast --format png --every-nth 2
# … 사용자 작업 또는 자동화 …
tirno screencast stop --out /tmp/cast
ffmpeg -framerate 30 -i /tmp/cast/frame-%06d.png -pix_fmt yuv420p /tmp/cast/out.mp4
tirno kill cast --clean
```

### 5. 자율 탐색 (mcp 에 없는 tirno 메인 가치)
```bash
# 성공하면 trail 자동 저장. 다음에 같은 goal 재실행하면 cache 로드.
tirno trail list
tirno trail replay "로그인 후 대시보드 이동"
```

---

## 완전 미구현 (직접 매핑 없음, raw CDP 우회만)

이 영역은 tirno 직접 명령이 없다 — 사용자에게 명시:

1. **`get_tab_id` (실험적)** — `tirno pages` 의 ID 또는 `tirno cdp Target.getTargets`
2. **`navigate_page initScript`** — `tirno cdp Page.addScriptToEvaluateOnNewDocument` 후 nav
3. **`fill` checkbox/select 자동 분기** — selector 가 select 이면 eval, checkbox 면 click 으로 우회
4. **`evaluate_script` 의 uid args 형식** — 함수 + element handle 배열은 미지원. expression 으로 inline
5. **`audit timespan` 모드** — split start/stop 이라 daemon 필요 (screencast/trace 와 같은 패턴으로 추후)
6. **`get_nodes_by_class` (heap)** — class UID 별 instance 추적 미구현. `memory details` aggregate 만
7. **Extensions 5종** (`install/uninstall/list/reload/trigger`) — `tirno cdp Extensions.*` raw passthrough만
8. **Third-party / WebMCP 4종** (`list/execute_3p_developer_tools`, `list/execute_webmcp_tools`) — `tirno eval "window.__dtmcp.*"` 우회
9. **단일 element 의 a11y/dom/bbox 조회** — `tirno inspect <selector>` 라는 명령은 **없다**(`src/commands/inspect.ts` 는 screenshot/snapshot/console/network 를 등록하는 모듈 파일이지 명령이 아니다). `tirno snapshot` 으로 트리 전체를 뜨고 `@N` 을 쓰거나, 이미 캐시된 페이지면 `tirno cache load <url>` 이 ref + selector + bbox 를 emit 한다

> 위 모든 항목은 `tirno cdp <method> [params-json]` 로 raw CDP 호출 가능. 특정 영역만 자주 쓰면 별도 wrapper PR 검토.

---

## 작업 원칙 (tirno 가치 흐름)

목표 도달 우선순위 — 위에서 아래로 시도, 마지막은 사용자 부탁:

1. **cache lookup** — 결정론, ms 단위 (`tirno cache load <url>`)
2. **multi-channel fallback** (selector → a11y → bbox → ocr text) — 결정론, ms 단위
3. **CDP 직접 분석 + 자율 시도** — agent 가 페이지 구조 뜯어보며 행동경로 발견
5. **사용자 시연 부탁** — `tirno trail capture` / `tirno record start`. 위 모두 실패 시 마지막 보루

**tirno 안에 LLM 은 없다** — 지능이 필요한 판단은 이 도구를 부르는 쪽이 한다. 결정론 층이 막히면 마지막 보루로 사용자 시연을 부탁한다.

---

## 참조 파일 (repo 내)

- `docs/research-chrome-devtools-mcp-mapping.md` — mcp tool 별 검증 결과 + 갭 분석 (이 skill 의 기반)
- `docs/plan-anchor-broker.md` — 앵커·소유권 설계와 Gate 실측 기록 (§7 에 실제 출력)
- `docs/research-multi-browser.md` — Firefox/Safari/WebKit 지원 가능성
- `CLAUDE.md` — tirno 의 가치 흐름 / 작업 원칙
- `.mcp.json` — 검증용 chrome-devtools-mcp 설정 (자동 npx 실행)
- `.claude/skills/tirno.md` — tirno 기본 사용법 skill
