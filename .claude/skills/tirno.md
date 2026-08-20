# tirno

Multi-session browser automation CLI on raw CDP.
여러 Chrome 인스턴스를 세션으로 관리하고, CDP 명령을 보낸다.

## 사용법

```
/tirno <command> [args]
```

## 설치

```bash
cd ~/rockheung/tirno
npm install && npm run build
npm link   # 또는 PATH에 bin/ 추가
```

## 세션 관리

```bash
tirno new <name> [url] [-- chrome-flags...]  # Chrome 세션 생성
tirno restart <name> [url] [-- flags...]     # 죽이고 새 플래그로 재생성
tirno ls [--json] [--flags]                  # 세션 목록 (STATUS + OWNER 컬럼)
tirno attach <name>                          # 활성 세션 설정
tirno kill <name|--all> [--clean]            # 세션 종료 (foreign/ambiguous 는 거부)
tirno rename <old> <new>                     # 세션 이름 변경
tirno export <name>                          # 세션 설정 JSON 출력
tirno gc [--dry-run] [--older-than <days>]   # 낡은 장부·잔존 파일 정리
tirno drift [name] [-- <flags>]              # 선언한 플래그 vs 실행 중 프로세스
```

세션 = 독립된 Chrome 프로세스. 각각 고유한 포트, user-data-dir, Chrome 플래그를 가짐.
`--` 뒤에 Chrome 플래그를 전달:

```bash
tirno new sandweb -- --no-proxy-server --ignore-certificate-errors \
  --host-resolver-rules="MAP *.internal-test.example 127.0.0.1"

tirno new mitmproxy -- --proxy-server=http://127.0.0.1:8888

tirno new mobile -- --window-size=375,812
```

## CDP 명령

모든 CDP 명령에 `-s <session>` 옵션. 생략하면 `tirno attach`로 설정한 활성 세션 사용.

### 탐색

```bash
tirno nav <url> [-s session]       # URL 이동
tirno reload [--hard]              # 새로고침
tirno back / forward               # 히스토리
tirno pages [--json]               # 탭 목록 (ID 는 안정 핸들)
tirno select <id>                  # 탭 선택
tirno new-tab [url]                # 새 탭
tirno close-tab <id>               # 탭 닫기
```

탭 ID 는 **위치 인덱스가 아니다.** CDP targetId 앞 8자리라 탭이 열리고 닫혀도 그 탭을
가리킨다 — `pages` 로 받은 ID 를 나중에 `close-tab` 에 넣어도 그 사이 다른 탭이 열렸다고
엉뚱한 탭이 닫히지 않는다. 4자 이상이면 접두사로도 지정된다.

### 조사

```bash
tirno screenshot [--out path] [--full] [--format png|jpeg|webp]
tirno snapshot [--verbose]         # a11y 트리. 노드마다 @N ref 부여, ~/.tirno/refs/<session>.json에 저장
tirno console [--type error|warn] [--reload] [--ms <n>]   # 리스너 창 동안의 콘솔
tirno console --show <id>          # 그 메시지 하나를 전문으로
tirno network [--type xhr|fetch]   # 네트워크 요청 (reload 하고 networkidle2 까지 캡처)
tirno network --show <id>          # 그 요청의 헤더·본문
```

### 입력

```bash
tirno click <selector|@N> [--dbl]      # selector 또는 @N ref (snapshot에서 부여된 번호)
tirno fill <selector|@N> <value>
tirno type <text> [--delay ms]
tirno press <key>                       # Enter, Tab, Escape, ArrowDown...
tirno hover <selector>
tirno drag <from> <to>                  # 좌표 "x,y" 또는 selector (자동 판별)
tirno upload <selector> <files...>
tirno scroll <up|down|<pixels>> [--step <px>]
tirno wait <ms>                         # 단순 sleep
tirno wait-for <selector> [--timeout ms]
tirno wait-for --network-idle [--timeout ms]
```

### 평가

```bash
tirno eval <expression>
tirno eval "document.title"
tirno eval "JSON.stringify(performance.timing)" --json
```

### 에뮬레이션

```bash
tirno emulate --device "iPhone 14"
tirno emulate --network slow-3g     # slow-3g, fast-3g, 4g, offline
tirno emulate --cpu 4               # 4x CPU 감속
tirno emulate --dpr 2               # device pixel ratio 단독 또는 device와 조합
tirno emulate --reset               # emulation 해제
tirno emulate --list-devices        # 프리셋 목록
```

emulation 상태는 `SessionMetadata.emulation`에 저장되어 connect마다 자동 재적용 (`page.emulate()` 사용으로 UA/touch도 새 connection에서 유지).

### 성능 · 진단

```bash
tirno stall [--window <s>] [--json]           # 메인스레드가 포화됐나. 렌더러 밖에서 잰다
tirno audit [url] [--categories <list>]       # Lighthouse. 세션의 chrome 을 재사용한다

tirno trace [--duration <s>] [--out <path>]   # 고정 시간 트레이스 후 저장
tirno trace start [path]                      # 상주 워커로 시작 (stop 까지 계속)
tirno trace stop <path>                       # 중단하고 trace.json 확정
tirno trace insight <path>                    # LCP / FCP / CLS / long task 추출

tirno memory [--out <path>]                   # 힙 스냅샷
tirno memory load <path>                      # 스냅샷 요약 통계
tirno memory details <path>                   # 타입별 집계 — retained size 상위 클래스

tirno screencast start [--out <dir>]          # 프레임 연속 캡처 (분리 프로세스)
tirno screencast stop                         # 중단하고 index.json 확정
```

`stall` 은 페이지가 먹통일 때 **쓰라고 있는 명령**이다. 다른 명령들이 렌더러에 물려
매달리는 상황에서도 계속 보고한다 — 브라우저 타깃에 별도 소켓으로 붙고, 렌더러로
가는 모든 호출에 데드라인을 건다.

### 멀티세션

```bash
tirno diff <s1> <s2> [--out path]     # 두 세션 스크린샷 시각 비교 (pixelmatch)
tirno broadcast [--group <g>] <cmd>   # 여러 세션에 같은 명령
```

`--group` 없는 `broadcast` 는 **모든 세션**에 간다.

### 자율 흐름 — cache · trail · 지능요청

가치 흐름(CLAUDE.md) 1~5번을 그대로 명령으로 옮긴 것들이다. 위에서 아래로 갈수록
비결정론적이고 비싸다.

```bash
tirno cache list|load|prune           # 1번. URL·viewport 키 스냅샷 저장소
tirno vision ocr [--backend <b>]      # 2번. OCR 채널 (기본 paddle, 로컬)
tirno cdp <method> [params]           # 3번. 모든 CDP 명령 raw passthrough
tirno ask <goal>                      # 4번. 단발 LLM 질의
tirno explore <goal>                  # 4번. cache → 채널 → CDP → LLM 자율 탐색
tirno trail capture|ls|show           # 5번. 마지막 보루 — 사용자 시연을 받는다
tirno record start|stop               # 사용자 입력 캡처
tirno replay <name>                   # 신뢰 이벤트로 재생. 채널 순서대로 폴백
```

**지능 백엔드는 claude 하나뿐이다.** `--backend openai|gemini` 는 인자로 받지만
`dispatcher.ts` 가 "not yet implemented" 로 던진다. vision 의 cloud 백엔드 3종도 stub 이고
실제로 도는 것은 로컬 paddle 이다.

### 자기 기술 — 에이전트는 `--help` 를 긁지 말 것

```bash
tirno schema [--pretty]          # 명령 트리 전체를 JSON 으로 (The CLI Spec v0.3)
```

`--help` 은 사람용 산문이라 서브커맨드 27개가 최상위에 안 보이고, 여러 줄 설명이
명령 목록과 섞여 파싱하면 없는 플래그가 나온다. `schema` 는 commander 트리에서
자동 생성되므로 CLI 와 어긋날 수 없다. 엔드포인트마다 다음을 선언한다:

- `effects` — `read_only` / `idempotent` / `non_idempotent`
- `destructive` — **되돌릴 수 없이 뭔가를 없앤다**: `kill` `gc` `restart` `close-tab`
  `cache prune` `trail rm` `record rm` `auth rm`. 실행 전에 이걸 보면 된다
- `passthrough` — `-- <chrome flags>` 를 받는 명령(`new` `restart` `drift`)
- `args` / `options` / `cardinality` / `output_kind`

### 부수

```bash
tirno auth set|rm <provider>     # API 키를 OS 키체인에 (anthropic|openai|gemini)
tirno auth status                # 어느 provider 가 키를 갖고 있나 (env·키체인)
tirno stats                      # ~/.tirno/metrics.jsonl 집계
```

## 세션 메타데이터

`~/.tirno/sessions/<name>.json`에 저장:
- PID, port, wsEndpoint, userDataDir, chromeFlags, createdAt, lastAccessedAt
- emulation: { device, viewport, network, cpu }

**장부는 기동 시점의 주장이지 사실이 아니다.** `port` 와 `wsEndpoint` 는 캐시 힌트로,
Chrome 이 재기동하면 (새 포트·새 browser UUID 로) 낡는다. 살아있는 값은
`profiles/<name>/DevToolsActivePort` 이고 연결은 그쪽을 먼저 읽는다. 고정 포트로 띄운
레거시 세션은 그 파일이 없어 `wsEndpoint` 로 폴백한다.

`~/.tirno/profiles/<name>/` — 세션별 Chrome 프로필 디렉토리. **로그인된 브라우저 세션이다.**
`~/.tirno/anchors/<name>` — 브라우저 MCP 가 가리키는 심링크 (→ profiles/<세션>).
`~/.tirno/active` — 현재 활성 세션 이름.
`~/.tirno/refs/<name>.json` — snapshot에서 부여된 @ref → backendDOMNodeId 매핑.

`TIRNO_DIR` 로 이 트리 전체를 옮길 수 있다(테스트용).

## 포트 — OS 가 준다

기본은 `--remote-debugging-port=0`. **포트를 tirno 가 고르지 않는다.** OS 가 빈 포트를
주고, Chrome 이 그 값을 `~/.tirno/profiles/<name>/DevToolsActivePort` 에 쓴다. 9222+ 는
공용 대역이라 다른 앱이 점유하는 일이 흔한데, 그 충돌 부류가 통째로 사라진다.

`--port <n>` 은 레거시 고정 포트 경로다. 이때 Chrome 은 `DevToolsActivePort` 를
**쓰지 않으므로** 그 세션은 앵커 대상이 될 수 없다(`tirno new` 가 경고한다).

## 앵커 — 브라우저 MCP 는 포트가 아니라 디렉토리를 가리킨다

```bash
tirno anchor ls [--json]                  # 앵커 목록 + 가리키는 대상 + 그게 우리 것인지
tirno anchor set <anchor> <session> [--evict]   # 앵커를 세션 프로필로 돌린다
tirno anchor rm <anchor>                  # 심링크만 제거 (프로필은 안 건드림)
```

`~/.tirno/anchors/<name>` 은 세션 프로필을 가리키는 심링크다. 브라우저 MCP 를 **한 번만**
이렇게 물려두면 된다:

```
npx chrome-devtools-mcp --auto-connect --user-data-dir=~/.tirno/anchors/main
```

MCP 는 연결할 때마다 `<dir>/DevToolsActivePort` 를 다시 읽는다. 그래서 Chrome 을 재기동해
포트가 바뀌어도 **MCP 재시작 없이** 따라온다. `--evict` 는 앵커가 이전에 가리키던 Chrome 을
같이 죽여, 이미 붙어 있는 MCP 가 새 쪽으로 재연결하게 만든다.

앵커는 `active`(CLI 의 활성 세션)와 **별개다.** `tirno attach` 로 CLI 세션을 바꿔도 남의
MCP 가 조용히 다른 브라우저로 옮겨가지 않는다.

## 소유권 — 장부가 아니라 관측

`tirno ls` 의 `STATUS` 는 장부의 pid 가 살아있는지이고, `OWNER` 는 **실제로 관측한 결과**다.

| OWNER | 뜻 |
|---|---|
| `ours` | pid 생존 ∧ 그 pid 가 그 포트를 LISTEN ∧ user-data-dir 이 이 세션 것 — 셋 다 일치 |
| `foreign(<앱이름>)` | 그 포트를 남이 쥐고 있다. 점유자 이름을 같이 보여준다 |
| `ambiguous` | 한 포트에 리스너가 둘 이상(예: 옛 chrome 이 IPv4, 새 chrome 이 IPv6) |
| `ghost` | 리스너가 없다. 장부만 남은 것 |

셋이 다 맞아야 `ours` 다. 하나만으로는 안 되는 이유 — pid 는 재사용되고, 포트는 무관한
프로세스가 물려받고, 커맨드 이름이 같다고 같은 프로필을 연 것은 아니다.

`foreign`/`ambiguous` 는 **표시만 하고 절대 자동으로 손대지 않는다.** `tirno kill` 도
거부한다(`gc` 로 장부 항목만 지울 수 있다 — 프로세스와 프로필은 그대로 둔다).

## 주의사항

- Chrome이 설치되어 있어야 함 (`/Applications/Google Chrome.app` 또는 `--executable-path`)
- `tirno kill`은 Chrome 프로세스만 종료. `--clean`으로 프로필 디렉토리도 삭제.
- `tirno ls`의 `dead`(STATUS)와 `ghost`(OWNER)는 다른 말이다. `dead` 는 장부의 pid 가
  없다는 것이고, `ghost` 는 그 포트에 리스너가 아예 없다는 것. **`dead` 인데 OWNER 가
  `foreign` 이면 그 포트는 남이 쓰고 있다** — 그 세션에 붙거나 죽이려 하면 안 된다.
- 정리는 `tirno gc`. 기본은 되돌릴 수 있는 것만(장부 항목, 잔존 `DevToolsActivePort`)
  치우고 브라우저는 절대 죽이지 않는다. 프로필 삭제는 `--older-than <days>` 를 줘야 하고
  고아 프로필만 대상이다 — 앵커가 걸린 것, active, 살아있는 것은 남는다. 먼저 `--dry-run`.
- 라우팅 설정을 바꿨는데 반영이 안 되면 `tirno drift`. `--host-resolver-rules` 같은 플래그는
  Chrome 이 기동 때 한 번만 읽으므로 재기동 외에는 방법이 없다. 지금 원하는 플래그를
  `-- <flags>` 로 주면 그 기준으로 비교한다. 재기동은 싸다 — 포트는 OS 가 새로 주고,
  프로필(로그인)은 남고, 디렉토리 앵커를 쓰는 MCP 는 다음 호출에서 알아서 따라온다.
- 명령마다 CDP 연결 → 실행 → 연결 해제. Chrome은 독립 실행 유지.
- @ref는 snapshot 직후에만 유효. 페이지가 바뀌면 snapshot 다시.
