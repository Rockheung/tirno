# chrome-devtools-mcp ↔ tirno CLI 1:1 매핑 (전수 검증)

> 출처: `https://github.com/ChromeDevTools/chrome-devtools-mcp` (2026-05-11 기준 main).
> 검증: 본 repo `.mcp.json` 으로 chrome-devtools-mcp 등록 후, 각 tool 에 대응하는 tirno CLI 명령을 headless chrome 세션에서 실제 실행해 결과 확인.

## 요약

| 분류 | mcp tool 수 | tirno 직접 매핑 | tirno raw CDP (`tirno cdp`) | tirno 미지원 |
|---|---|---|---|---|
| Navigation | 7 | 6 | 1 (`get_tab_id`) | 0 |
| Input | 10 | 9 | 1 (`handle_dialog` — 자동) | 0 |
| Emulation | 2 | 2 (viewport/network/cpu/device/UA/colorScheme/geolocation) | — | 0 |
| Network | 2 | 2 (`network` / `network show <id>`) | — | 0 |
| Performance | 3 | 3 (`trace start` / `trace stop` / `trace insight`) | — | 0 |
| Debugging | 8 | 8 (`console --show <id>` / `audit` / `screencast start`·`stop` 포함) | — | 0 |
| Memory | 4 | 3 (`memory` / `memory load` / `memory details`) | — | 1 (`get_nodes_by_class`) |
| Extensions | 5 | 0 | 5 (`Extensions.*` raw) | — |
| Third-Party / WebMCP | 4 | 0 | — | 4 (실험적, off-by-default) |
| Slim build (3) | 3 | 3 | — | 0 |
| **합계** | **48** | **36** | **7** | **5 (실험적·off-by-default)** |

핵심 — 실용 surface 는 전부 덮었다. 남은 5건은 `get_nodes_by_class` 와 mcp 에서도 off-by-default 인
실험 도구(third-party / WebMCP)뿐이다.

---

## NAVIGATION

| mcp tool | tirno 명령 | 검증 결과 | 비고 |
|---|---|---|---|
| `list_pages` | `tirno pages` | ✅ ID/title/URL 테이블 출력 | — |
| `select_page` | `tirno select <id>` | ✅ `Selected page 0` | bringToFront 옵션은 미지원, 필요 시 `tirno cdp Target.activateTarget` |
| `close_page` | `tirno close-tab <id>` | ✅ `Closed tab 0` | — |
| `new_page` | `tirno new-tab [url]` | ✅ 새 탭 생성 | background/isolatedContext/allowList 미지원 |
| `navigate_page` (type=url) | `tirno nav <url>` | ✅ 200/304 status 반환 | initScript 미지원 — 필요 시 `Page.addScriptToEvaluateOnNewDocument` |
| `navigate_page` (type=back) | `tirno back` | ✅ history 있을 때 동작 | history 없으면 명확한 에러 |
| `navigate_page` (type=forward) | `tirno forward` | ✅ | 동일 |
| `navigate_page` (type=reload) | `tirno reload` | ✅ | `ignoreCache` 는 raw CDP `Page.reload {ignoreCache:true}` |
| `wait_for` (text 기반) | `tirno wait-for <selector>` | ⚠️ selector 만 지원 | text wait 은 `tirno eval "document.body.innerText.includes('...')"` polling 으로 우회 |
| `get_tab_id` (실험적) | `tirno cdp Target.getTargets` (raw) | ✅ raw 가능 | 직접 매핑 없음, `pages` 출력의 ID로 충분 |

---

## INPUT

| mcp tool | tirno 명령 | 검증 결과 | 비고 |
|---|---|---|---|
| `click` (uid) | `tirno click @N` 또는 `tirno click <css>` | ✅ `BTN-CLICKED` 확인 | mcp 의 `uid` ↔ tirno snapshot `@N`. 둘 다 a11y backendNodeId 기반 |
| `click_at` (x,y) | `tirno click "<x>,<y>"` | ✅ wave 4 추가 — 좌표 형태면 `Input.dispatchMouseEvent` 로 trusted click |
| `hover` | `tirno hover <selector>` | ✅ | — |
| `fill` (text/checkbox/select 자동) | `tirno fill <target> <value>` | ✅ "hello-world" 입력 확인 | checkbox/select 자동 분기는 미지원 — `tirno eval` 또는 `click + press` 조합 |
| `type_text` | `tirno type <text>` (+ `tirno press <key>`) | ✅ "via-keyboard" 입력 | submitKey 옵션은 별도 `press` 호출 |
| `drag` (uid→uid) | `tirno drag <from> <to>` (selector or "x,y") | ✅ 33,255 → 108,130 | mouse-only fallback (drag data 없음) — drag&drop API 가 필요한 경우 미동작 가능 |
| `fill_form` (배치) | shell 루프로 `tirno fill` × N | ⚠️ 배치 명령 없음 | 단일 호출보다 늦지만 동작은 동일 |
| `upload_file` | `tirno upload <selector> <files...>` | ✅ `mcp-up.txt` 업로드 확인 | DOM.setFileInputFiles 사용 |
| `press_key` | `tirno press <key>` | ✅ Tab/Enter 동작 | `Control+Shift+R` 같은 modifier+key 도 지원 (chord 표기) |
| `handle_dialog` | (자동 처리) `tirno cdp Page.handleJavaScriptDialog` | ✅ 자동 dismiss | tirno 는 default 로 dialog 우회. 명시 accept/dismiss 필요 시 raw CDP |

---

## EMULATION

| mcp tool | tirno 명령 | 검증 결과 | 비고 |
|---|---|---|---|
| `emulate networkConditions` | `tirno emulate --network <profile>` | ✅ slow-3g 적용 | profiles: slow-3g/fast-3g/4g/offline |
| `emulate cpuThrottlingRate` | `tirno emulate --cpu <rate>` | ✅ 4x 적용 | — |
| `emulate viewport` | `tirno emulate --viewport <wxh>` (+ `--dpr`) | ✅ 800x600 → innerWidth 확인 | mobile/touch/landscape flag 는 device preset 으로 대체 |
| `emulate userAgent` | `tirno cdp Network.setUserAgentOverride '{"userAgent":"..."}'` | ⚠️ raw CDP | `--user-agent` 옵션 추가 검토 가치 |
| `emulate colorScheme` | `tirno cdp Emulation.setEmulatedMedia '{"features":[{"name":"prefers-color-scheme","value":"dark"}]}'` | ⚠️ raw CDP | `--color-scheme` 옵션 추가 검토 가치 |
| `emulate geolocation` | `tirno cdp Emulation.setGeolocationOverride '{"latitude":...,"longitude":...,"accuracy":50}'` | ⚠️ raw CDP (권한 별도) | navigator.geolocation API 는 추가로 `Browser.grantPermissions` 필요 |
| `emulate device preset` | `tirno emulate --device "iPhone 13"` | ✅ UA + viewport + dpr 일괄 | mcp 에는 별도 device preset 없음 — tirno 가 더 편함 |
| `resize_page` | `tirno emulate --viewport <wxh>` | ✅ 동일 | mcp 는 별도 tool, tirno 는 통합 |

---

## NETWORK

| mcp tool | tirno 명령 | 검증 결과 | 비고 |
|---|---|---|---|
| `list_network_requests` | `tirno network` | ✅ 1 request (GET / 200) 캡처 | pageSize/pageIdx/resourceTypes/preserved 옵션은 미지원 — 필요 시 stdout 파싱 |
| `get_network_request` (요청+응답 본문) | `tirno cdp Network.getResponseBody '{"requestId":"..."}'` | ⚠️ raw CDP | `tirno network --json` + cdp 조합 |

---

## PERFORMANCE

| mcp tool | tirno 명령 | 검증 결과 | 비고 |
|---|---|---|---|
| `performance_start_trace` (+ auto-stop) | `tirno trace --duration <s> --out <path>` | ✅ 62KB trace.json 저장 | one-shot fixed-duration |
| `performance_start_trace` (manual stop) | `tirno trace start <path>` | ✅ wave 4 — daemon worker (screencast 와 같은 패턴) |
| `performance_stop_trace` | `tirno trace stop <path>` | ✅ wave 4 — SIGTERM 으로 finalize |
| `performance_analyze_insight` | ❌ | 미지원 | trace.json 을 chrome://tracing 또는 외부 도구로 분석 |

---

## DEBUGGING

| mcp tool | tirno 명령 | 검증 결과 | 비고 |
|---|---|---|---|
| `list_console_messages` | `tirno console` | ✅ "No messages captured" (빈 페이지) | listener 활성화 후 캡처 |
| `get_console_message` (단건) | `tirno console --json` + jq | ⚠️ 직접 명령 없음 | 전체 출력 후 필터 |
| `take_screenshot` | `tirno screenshot --out <path>` | ✅ 1920x1080 PNG (49KB) | format/quality/fullPage 일부 옵션 지원 (`--full`/`--format`) |
| `take_snapshot` (a11y) | `tirno snapshot` | ✅ `@1 RootWebArea ...` 트리 출력 | mcp 의 `uid` ↔ tirno `@N` 동일 의미 |
| `screencast_start` | ❌ | 미지원 | mcp 도 ffmpeg 의존 — 필요 시 `tirno cdp Page.startScreencast` |
| `screencast_stop` | ❌ | 미지원 | 동일 |
| `evaluate_script` | `tirno eval <expression>` | ✅ "Example Domain" / "2" | mcp 는 함수 형태 + args(uid handle), tirno 는 expression. 결과 동일 |
| `lighthouse_audit` | ❌ | 미지원 | 별도 lighthouse CLI 또는 PR 검토 |

---

## MEMORY

| mcp tool | tirno 명령 | 검증 결과 | 비고 |
|---|---|---|---|
| `take_memory_snapshot` | `tirno memory --out <path>` | ✅ 5.1MB heapsnapshot 저장 | DevTools Memory tab 으로 열기 |
| `load_memory_snapshot` (실험적) | ❌ | 미지원 | tirno 는 capture 만 |
| `get_memory_snapshot_details` (실험적) | ❌ | 미지원 | DevTools UI 또는 외부 분석 |
| `get_nodes_by_class` (실험적) | ❌ | 미지원 | 동일 |

---

## EXTENSIONS (default off in mcp, off in tirno)

`tirno cdp Extensions.loadUnpacked` / `Extensions.uninstall` / `Extensions.getStorageItems` 같은 raw CDP 호출로 대체 가능. 직접 명령은 미지원 — 사용 빈도가 낮아 우선순위 낮음.

---

## THIRD_PARTY / WEBMCP (실험적, off-by-default)

`list_3p_developer_tools` / `execute_3p_developer_tool` / `list_webmcp_tools` / `execute_webmcp_tool` — 페이지가 `window.__dtmcp` 또는 WebMCP API 를 노출했을 때만 동작하는 메타 도구. tirno 는 `tirno eval "window.__dtmcp"` 로 일반화 가능하지만 별도 wrapper 는 없음. 우선순위 낮음.

---

## SLIM BUILD (3 tools, mcp `--slim` 모드)

| mcp slim | tirno | 검증 |
|---|---|---|
| `screenshot` | `tirno screenshot` | ✅ |
| `navigate` (URL only) | `tirno nav <url>` | ✅ |
| `evaluate` (expression) | `tirno eval <expression>` | ✅ |

slim 모드 3개는 tirno 의 기본 surface 에 그대로 포함.

---

## tirno 의 우위 영역 (mcp 에 없음)

- `tirno new <name> [url]` — 동시 다세션 (mcp 는 단일 브라우저 인스턴스)
- `tirno ls` / `tirno attach <name>` — 세션 관리 + 활성 세션 전환
- `tirno cdp <method> [params]` — 모든 CDP 명령 raw passthrough (mcp 는 정의된 tool 만)
- `tirno cache` — URL/viewport 키 visual cache (재현/diff 용)
- `tirno vision ocr` — multi-channel OCR
- `tirno record` / `tirno replay` — 사용자 동작 캡처 + 재생 (raw CDP trusted events)
- `tirno trail` — multi-channel fallback 의 trail 저장/replay
- `tirno explore <goal>` — cache → multi-channel → CDP → LLM 자율 탐색
- `tirno ask <goal>` — 단발 LLM 질의
- `tirno emulate --device <preset>` — UA/viewport/dpr 일괄 (mcp 는 분리)
- `tirno broadcast <cmd>` — 다세션 동시 실행
- `tirno diff <s1> <s2>` — 두 세션 visual diff
- `tirno stats` — `metrics.jsonl` 집계

## tirno 의 보강 영역 (gap, mcp 가 가진 것)

**2026-08-18 재확인: 아래 9건은 전부 닫혔다.** wave 1~4 (#36 · #37 · #38 · #40) 가
받았고, 현행 CLI 로 실행해 확인했다.

| 갭 | 현행 |
|---|---|
| `wait_for` text 기반 | `tirno wait-for --text <s>` |
| `emulate --user-agent` / `--color-scheme` | 둘 다 플래그로 존재 |
| `emulate geolocation` | `tirno emulate --geolocation` |
| `fill_form` 배치 | `tirno fill` 이 배열 인자를 받는다 |
| `lighthouse_audit` | `tirno audit` |
| `screencast_*` | `tirno screencast start` / `stop` |
| `performance_analyze_insight` | `tirno trace insight <path>` — LCP / FCP / CLS / long task |
| `get_console_message` 단건 | `tirno console --show <id>` |
| `get_network_request` 본문 | `tirno network show <id>` |

남은 것은 둘뿐이다:

- **`get_nodes_by_class`** — `tirno memory` 는 capture · `load` · `details` 까지다.
- **third-party / WebMCP 4건** — mcp 에서도 off-by-default 인 실험 도구.

---|---|---|
| `wait_for` text 기반 | 흔한 패턴 | 낮음 — `--text <s>` 옵션 추가 |
| `emulate --user-agent` / `--color-scheme` | 자주 쓰임 | 낮음 — flag 추가 |
| `emulate geolocation` (+ permissions) | 위치 기반 사이트 테스트 | 중간 — Browser.grantPermissions 같이 |
| `fill_form` 배치 | UX 편의 | 낮음 — 배열 인자 받는 wrapper |
| `lighthouse_audit` | audit 워크플로 | 중간 — lighthouse npm 의존 |
| `screencast_*` | 시연 녹화 | 중간 — ffmpeg 의존 |
| `performance_analyze_insight` | trace 분석 자동화 | 중간 — chrome-devtools-frontend insights 모듈 차용 |
| `get_console_message` 단건 | 미세 UX | 낮음 — `--id <n>` 옵션 |
| `get_network_request` 본문 | 응답 확인 | 낮음 — `tirno network show <id>` 추가 |

---

## 부록: 본 검증에 사용한 명령 시퀀스

```bash
# 세션 띄우기
node bin/tirno.js new mcp-test https://example.com --headless --ephemeral

# Navigation
node bin/tirno.js pages
node bin/tirno.js new-tab https://httpbin.org/get
node bin/tirno.js select 0
node bin/tirno.js close-tab 0
node bin/tirno.js reload
node bin/tirno.js nav https://example.com
node bin/tirno.js back && node bin/tirno.js forward
node bin/tirno.js wait-for body

# Input (file:///tmp/mcp-form.html — input/button/select/checkbox/dropzone 포함)
node bin/tirno.js click "#b"
node bin/tirno.js fill "#t" "hello-world"
node bin/tirno.js type "via-keyboard"
node bin/tirno.js press Enter
node bin/tirno.js hover "#b"
node bin/tirno.js drag "#src" "#dropzone"
node bin/tirno.js drag "100,100" "200,200"
node bin/tirno.js upload "#f" /tmp/mcp-up.txt
node bin/tirno.js scroll down
node bin/tirno.js wait 100
node bin/tirno.js snapshot   # @1..@N uid 출력
node bin/tirno.js click "@5" # @ref 클릭 — uid 기반 매핑

# Emulation
node bin/tirno.js emulate --viewport 800x600
node bin/tirno.js emulate --network slow-3g
node bin/tirno.js emulate --cpu 4
node bin/tirno.js emulate --device "iPhone 13"
node bin/tirno.js cdp Emulation.setGeolocationOverride '{"latitude":37.5,"longitude":127.0,"accuracy":50}'
node bin/tirno.js cdp Emulation.setEmulatedMedia '{"features":[{"name":"prefers-color-scheme","value":"dark"}]}'
node bin/tirno.js cdp Network.setUserAgentOverride '{"userAgent":"tirno/test"}'

# Inspect / Debug
node bin/tirno.js screenshot --out /tmp/mcp-test.png
node bin/tirno.js eval "document.title"
node bin/tirno.js console
node bin/tirno.js network

# Perf / Memory
node bin/tirno.js trace --duration 2 --out /tmp/mcp-trace.json
node bin/tirno.js memory --out /tmp/mcp-heap.heapsnapshot

# 정리
node bin/tirno.js kill mcp-test --clean
```
