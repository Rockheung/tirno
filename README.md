# tirno

Multi-session browser automation CLI on raw CDP.

여러 Chrome 인스턴스를 세션으로 관리하고, CDP 명령을 CLI로 실행한다. agent가 사이트를 돌아다니며 알아낸 사실을 누적하고 다음 시도에 빠르게 재사용하는 게 목표.

## 핵심 컨셉

| 컨셉 | 설명 |
|---|---|
| **Multi-session** | `tirno new <name>`으로 독립 Chrome 인스턴스. user-data-dir 별도 → cookie/storage 격리. tmux 스타일 |
| **Stateless CLI** | 명령마다 connect/disconnect. daemon 없음 — `~/.tirno/sessions/<name>.json`에서 메타 복원 |
| **a11y `@ref`** | `tirno snapshot`이 accessibility tree에 `@1`, `@2` 식으로 ref 부여 → `click @7`, `fill @39 "..."` 가능 |
| **Visual cache (Phase 6-1)** | snapshot 종료 시 a11y refs + selector + bbox + 64bit dHash를 URL key별로 자동 캐시 → 재방문 시 `cache load`로 즉시 emit |
| **Broadcast** | `tirno broadcast nav <url>` — 모든 세션에 동시 명령 |
| **Emulation** | device/network/cpu/dpr emulation 영속 — 한번 적용하면 다음 명령에서도 유지 |

## 설치

```bash
git clone https://github.com/Rockheung/tirno
cd tirno
npm install
npm run build
node bin/tirno.js --help
```

전역 설치는 `npm link` 또는 `npm i -g .` 후 `tirno`로 호출.

요구사항: Node 22+, Google Chrome (`/Applications/Google Chrome.app` macOS 또는 `google-chrome` Linux).

## Quick start

```bash
# 세션 시작 + 페이지 열기
tirno new mysession
tirno nav https://example.com

# 스냅샷으로 element 식별
tirno snapshot
# @1  RootWebArea "Example Domain"
# @7  link "Learn more"

# ref로 클릭 / 입력
tirno click @7

# 캐시된 페이지 재로드
tirno cache load https://example.com

# 종료
tirno kill mysession
```

## 명령 reference

### 세션
| 명령 | 설명 |
|---|---|
| `new <name> [-- <chrome-flags>]` | 새 Chrome 세션 생성. `--`로 임의 flag 전달 (`--proxy-server`, `--host-resolver-rules` 등). 포트는 OS가 할당(`--port`로 고정 가능하나 그러면 MCP 앵커 대상이 못 됨) |
| `ls` | 세션 목록 (port, status, **owner**, proxy, emulation, last access) |
| `attach <name>` | active 세션 변경 |
| `kill [name]` | 세션 종료. `foreign`/`ambiguous`면 거부 |
| `gc [--dry-run] [--older-than <N>]` | 낡은 장부 정리. 기본은 장부만(ghost/foreign 엔트리, 잔존 `DevToolsActivePort`). `--older-than <N>`일 때만 **N일 이상 안 쓴 orphan 프로필 삭제** |
| `drift [name] [--all] [-- <flags>]` | 선언한 chrome flag 와 실행 중 프로세스 비교. 차이 있으면 재기동 명령 제안 + **exit 1** |
| `rename <old> <new>` | 이름 변경 |
| `export <name>` | 메타데이터 출력 |

#### 소유권 (`ls` 의 OWNER)

세션 메타는 기동 시점의 주장이지 현재 사실이 아니다 — pid 는 재사용되고 포트는 다른
프로세스가 물려받는다. tirno 는 **세 사실이 모두 일치할 때만** 그 세션을 자기 것으로 본다:
pid 생존 ∧ 그 pid 가 그 포트를 LISTEN ∧ 그 프로세스의 `--user-data-dir` 이 세션 프로필과 일치.

| OWNER | 뜻 | 허용 조치 |
|---|---|---|
| `ours` | 3중 일치 | connect / kill |
| `foreign(<app>)` | 하나라도 불일치 — 그 포트는 남의 것 | 표시만. connect·kill 거부 |
| `ambiguous` | 같은 포트에 리스너 둘 이상 (IPv4/IPv6) | 표시만. 자동 조치 전면 금지 |
| `ghost` | 대장에만 있고 리스너·pid 없음 | connect 불가 (kill 로 정리 가능) |

#### drift — 실행 중인 옵션이 여전히 맞나

`--host-resolver-rules` 같은 flag 는 Chrome 이 **기동 시 한 번만 읽는** 스냅샷이다. 라우팅
설정을 바꿔도 이미 떠 있는 Chrome 은 옛 규칙을 그대로 쓴다. tirno 는 그 규칙의 의미를
모르지만(알 필요도 없다), **선언과 실제가 다르다**는 사실은 알려줄 수 있다.

```bash
tirno drift                                   # 대장의 chromeFlags vs 실행 중
tirno drift d1 -- --host-resolver-rules="…"   # 지금 원하는 flags vs 실행 중
```

```
→ changed  --host-resolver-rules: expected MAP example.com 10.0.0.1, running MAP example.com 127.0.0.1
✗ 'd1' has drifted. Chrome only reads these at launch — restart to apply:
→   tirno restart d1 https://example.com --headless --ephemeral -- --host-resolver-rules='MAP example.com 10.0.0.1'
```

제안 명령은 그대로 복붙하면 된다 — headless 여부·ephemeral 프로필·시작 URL·group 을
모두 실어 보내므로 세션의 성격이 바뀌지 않는다.

값에 `" --"` 가 든 플래그(`--user-agent="tirno --probe"` 등)는 `ps` 출력에서 되읽을 수
없어 `unreadable` 로 따로 보고하고 drift 로 세지 않는다. 거짓 일치도 아니고, 재기동해도
풀리지 않는 거짓 drift 도 아니다.

차이가 있으면 **exit 1** 이라 자동화에서 게이트로 쓸 수 있다. 재기동 비용은 앵커 방식에서
사실상 0 이다 — 포트 경합 없고, 프로필이 영속이라 로그인이 유지되고, MCP 는 다음 툴
호출에서 알아서 새 Chrome 에 붙는다.

puppeteer·Chrome 이 자기 기본 인자를 수십 개 붙이므로 **"선언에 없는데 실행 중"은 보고하지
않는다** — 정상 상태를 defect 로 올리면 의미 있는 신호가 묻힌다. 전체 커맨드라인은 `--all`.

`gc` 는 이 판정 위에서만 움직인다. **프로필 삭제는 로그인 세션 소실**이므로 `--older-than`
없이는 절대 지우지 않고, 앵커가 가리키는 프로필·active 세션·살아있는 세션은 어느 경우에도
보존한다. `foreign` 은 대장 엔트리(tirno 자기 json)만 지우고 프로세스·프로필은 건드리지
않는다. `ambiguous` 는 아무것도 하지 않는다. 먼저 `tirno gc --dry-run` 으로 확인할 것.

### 앵커 (브라우저 MCP 접속 대상)

| 명령 | 설명 |
|---|---|
| `anchor ls [--json]` | 앵커 → 세션 매핑과 각 대상의 포트·소유권 |
| `anchor set <anchor> <session> [--evict]` | 앵커를 세션 프로필로 향하게 함 (심링크 교체) |
| `anchor rm <anchor>` | 앵커 심링크만 제거 (프로필 불변) |

브라우저 MCP 를 **포트가 아니라 디렉토리**에 붙인다. `chrome-devtools-mcp` 는 툴 호출마다
재연결하며 그때 `<dir>/DevToolsActivePort` 를 다시 읽으므로, Chrome 이 재기동해서 포트가
바뀌어도 **MCP 재시작 없이** 따라간다.

```jsonc
// .mcp.json — 절대경로로 적을 것 ($HOME 전개 안 됨)
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest",
               "--auto-connect", "--user-data-dir=/Users/<me>/.tirno/anchors/main"]
    }
  }
}
```

```bash
tirno anchor set main mysession     # main 앵커를 mysession 으로
tirno anchor set main other --evict # 전환 + 이전 Chrome 종료
```

앵커는 여러 개 둘 수 있다(`main`, `wt-foo`, …) — 디렉토리는 포트와 달리 충돌하지 않으므로
MCP 엔트리를 하나 더 쓰면 worktree 병렬 작업이 된다.

주의 두 가지:

- **이미 연결된 MCP 는 심링크 교체만으로 옮겨가지 않는다.** 연결된 browser 를 캐시하기
  때문이다. `--evict` 로 이전 Chrome 을 종료해야 다음 툴 호출에서 새 대상에 붙는다.
- **앵커(`anchors/*`)와 CLI 의 `active` 는 별개다.** `tirno attach` 로 CLI 세션을 바꿔도
  MCP 대상은 그대로다 — 의도적 분리.

### 네비게이션
| 명령 | 설명 |
|---|---|
| `nav <url>` | URL로 이동 |
| `reload` / `back` / `forward` | 페이지 이력 제어 |
| `pages` / `select <id>` / `new-tab [url]` / `close-tab <id>` | 탭 제어. ID 는 CDP targetId 앞 8자리로, 탭이 열리고 닫혀도 안 바뀐다(위치 인덱스가 아니다). 4자 이상이면 접두사로도 된다 |

### 검사
| 명령 | 설명 |
|---|---|
| `screenshot [--full] [--out path]` | 스크린샷 |
| `snapshot [--no-cache] [--vision [backend]]` | a11y 트리 + visual cache 적재. `--vision`으로 OCR 보강 (default paddle). 옵션: `--vision-lang`, `--vision-min-confidence`, `--vision-iou`, `--vision-contain` |
| `console [--type <t>]` | 콘솔 메시지 (한정적 — stateless 모델 한계) |
| `network [--type <t>]` | reload 후 2초간 network 캡처 |

### 입력
| 명령 | 설명 |
|---|---|
| `click <selector\|@N>` | 클릭 |
| `fill <selector\|@N> <value>` | input clear + type |
| `type <text>` / `press <key>` / `hover <selector>` | 키보드/마우스 |
| `scroll up\|down\|<pixels>` | 스크롤 |
| `wait <ms>` / `wait-for [selector] [--network-idle]` | 대기 |
| `upload <selector> <files...>` | 파일 업로드 |

### 실행 / emulation
| 명령 | 설명 |
|---|---|
| `eval <expression>` | 페이지에서 JS 실행 |
| `emulate [--device <name>] [--dpr <n>] [--network <p>] [--cpu <n>] [--reset]` | 영속 emulation |

### 성능
| 명령 | 설명 |
|---|---|
| `stall [--window <s>]` | 메인스레드가 포화됐나, 무엇이 먹나. 렌더러 밖(브라우저 타깃)에서 재므로 페이지가 멈춰 DevTools 가 안 열려도 계속 관측된다 |
| `audit [url]` | Lighthouse. 세션의 chrome 을 재사용한다 |
| `trace --duration <s>` | chrome://tracing 호환 JSON |
| `trace start`·`stop`·`insight <path>` | 상주 워커로 구간 트레이스, LCP / FCP / CLS / long task 추출 |
| `memory` · `memory load <p>` · `memory details <p>` | heap snapshot, 요약, 타입별 retained size |
| `screencast start`·`stop` | 프레임 연속 캡처 |
| `diff <s1> <s2>` | 두 세션 시각 diff (pixelmatch) |

### Visual cache (viewport-aware)
| 명령 | 설명 |
|---|---|
| `cache list [--domain <d>] [--limit <n>]` | (URL × viewport)별 캐시 entry 목록 |
| `cache load <url> [--mode exact\|urlPath] [--viewport <wxh@dpr>]` | 캐시된 ref + selector + bbox emit. viewport 미지정 시 가장 최근 |
| `cache prune [--older-than <days>] [--domain <d>]` | 정리 |

저장 구조: `~/.tirno/visual-cache/<domain>/<sha1(urlPath)>/<wxh@dpr>.json`. 같은 URL이라도 viewport가 다르면(데스크톱 vs 모바일 emulate) 별개 entry로 공존. bbox는 viewport 종속이라 layout journaling엔 viewport 분리가 필수.

### Vision OCR
| 명령 | 설명 |
|---|---|
| `vision ocr [--backend <name>] [--lang <l>] [--full] [--out <path>] [--min-confidence <n>] [--paddle-models <dir>]` | 페이지 OCR — 단어/줄별 bbox + confidence |

backend 선택 — **local 기본**, cloud는 확장 예정 (현재 stub):

**local**:
- `paddle` (**default**) — PaddleOCR via @gutenye/ocr-node, line 단위, 영어 default. 한국어는 `--paddle-models <dir>` 로 PaddleOCR 한국어 det/rec/dict 지정
- `florence` — Florence-2 via `@huggingface/transformers`. **experimental** — 모델 로드/추론 인프라는 동작하나, transformers.js v4의 task token 처리에 디코딩 버그가 있어 output 정확성 미흡. env: `TIRNO_FLORENCE_MODEL`, `TIRNO_FLORENCE_DTYPE` (q4|q8|fp32), `TIRNO_FLORENCE_DEBUG=1`

**cloud** (Phase 6-2f 예정 — 현재 stub):
- `claude` — `ANTHROPIC_API_KEY`
- `openai` — `OPENAI_API_KEY`
- `gemini` — `GEMINI_API_KEY` 또는 `GOOGLE_API_KEY`

cloud backend는 API key 없으면 안내 메시지, 있으면 "not yet implemented" 메시지. CLI surface는 stable.

### 자기 기술 (agent 용)
| 명령 | 설명 |
|---|---|
| `schema [--pretty]` | 명령 트리 전체를 JSON 으로. [The CLI Spec](https://clispec.dev/) v0.3 형식 |

에이전트가 `--help` 를 긁을 필요가 없다 — 72개 엔드포인트가 `effects`(read_only / idempotent / non_idempotent)와 `destructive` 표시를 달고 나온다. commander 트리에서 자동 생성이라 CLI 와 어긋나지 않고, 분류가 빠지면 유닛 테스트가 깨진다.

### Multi-session
| 명령 | 설명 |
|---|---|
| `broadcast <cmd> [args...]` | 모든 세션에 동시 명령 |

## 데이터 위치

| 경로 | 내용 |
|---|---|
| `~/.tirno/sessions/<name>.json` | 세션 메타 (port, pid, emulation 상태) |
| `~/.tirno/profiles/<name>/` | Chrome user-data-dir (cookies, storage) |
| `~/.tirno/profiles/<name>/DevToolsActivePort` | Chrome이 직접 쓴 실제 포트 + ws 경로. 세션 메타의 `wsEndpoint`보다 이쪽이 진실 |
| `~/.tirno/anchors/<anchor>` | 프로필로의 심링크. 브라우저 MCP가 가리키는 곳 |
| `~/.tirno/refs/<name>.json` | snapshot의 ref → backendDOMNodeId 매핑 |
| `~/.tirno/visual-cache/<domain>/<sha1>.json` | URL-keyed snapshot 캐시 |
| `~/.tirno/active` | 현재 active 세션 |

환경변수: `TIRNO_CACHE_DIR`로 visual cache 위치 override (테스트용).

## 개발

```bash
npm install
npm run build           # tsc → dist/
npm run dev             # tsc --watch
npm test                # node:test, 의존성 0
```

## 라이선스

ISC

## 진행 상황

작업 일지는 [docs/JOURNAL.md](docs/JOURNAL.md), 비교 도구 리서치는 [docs/RESEARCH.md](docs/RESEARCH.md).

**anchor broker** — 브라우저 MCP 접속 대상을 포트가 아닌 디렉토리로, 소유권을 관찰로
판정. Gate 1~4 · Stage 1~5 모두 반영됐다(앵커 · 소유권 · gc · drift).
설계 문서: [docs/research-anchor-broker.md](docs/research-anchor-broker.md) ·
[docs/plan-anchor-broker.md](docs/plan-anchor-broker.md).

chrome-devtools-mcp 와의 도구 대조는
[docs/research-chrome-devtools-mcp-mapping.md](docs/research-chrome-devtools-mcp-mapping.md),
다른 엔진(Firefox / Safari) 지원 검토는
[docs/research-multi-browser.md](docs/research-multi-browser.md).
