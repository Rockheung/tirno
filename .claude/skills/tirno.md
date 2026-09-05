---
name: tirno
description: tirno CLI 레퍼런스 — 세션 관리(new/ls/kill/restart/gc)·소유권 판정·앵커·네비게이션·a11y @ref 조작·visual cache·기록/재생·emulation·진단(stall/audit/trace). 명령 표면과 그 의미를 찾을 때. "tirno 로 뭘 할 수 있나" · "이 명령 옵션이 뭐냐" 류. 작업 절차는 tirno-runbook, chrome-devtools-mcp 대응은 tirno-mcp.
---

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
tirno new <name> --extensions                # 확장이 돌게 한다 (기본은 꺼짐)
tirno restart <name> [url] [-- flags...]     # 죽이고 새 플래그로 재생성
tirno restart <name> --keep-cookies          # 세션 쿠키까지 넘긴다 — 로그인이 살아남는다
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

세션을 만들 때 프로필에 `translate.enabled = false` 를 심는다 — 번역 버블이 페이지 위에 겹쳐
뜨면 좌표와 스크린샷이 흔들린다. `--disable-features=Translate` 만으로는 안 막혔다(실측).
이미 값이 있으면 건드리지 않는다.
확장은 기본으로 꺼져 있다. `--extensions` 없이는 **어떤 방법으로도 못 켠다** — puppeteer 의
`--disable-extensions` 를 뒤에서 되돌릴 수 없고, `Extensions.loadUnpacked` 는 id 를 돌려주면서
아무것도 활성화하지 않는다. `--load-extension` 은 Chrome 151 에서 죽었으므로 로드는 CDP 로 한다:

```bash
tirno new dev --extensions
tirno cdp --browser Extensions.loadUnpacked '{"path":"/abs/path/to/ext"}'  # id 를 돌려준다
tirno reload            # content script 는 다음 문서부터
```

`path` 는 **디렉터리**(manifest.json 이 든 곳)여야 한다. zip 은 먼저 풀고, 압축 안에
한 겹 더 있으면 그 안쪽을 가리킨다 — `find <풀린곳> -name manifest.json` 으로 확인.

로드됐는지: `tirno cdp --browser Extensions.getExtensions '{}'` (name·version·enabled·id).

**액션(팝업)은 핀 없이 부른다.** `triggerAction` 은 `page` 가 아니라 **tab** 타깃을 받는다:

```bash
tirno cdp --browser Target.getTargets '{"filter":[{"type":"tab"},{}]}'   # tab id
tirno cdp --browser Extensions.triggerAction '{"id":"<ext id>","targetId":"<tab id>"}'
# → 팝업이 chrome-extension://<id>/popup.html page 타깃으로 뜬다
tirno nav chrome-extension://<id>/popup.html   # 또는 그냥 연다
```

**재기동하면 사라진다** — 프로필에 안 남으므로 `restart` 뒤에 다시 로드한다(id 는 같다).

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
                                        # selector 는 열린 shadow root 를 관통한다
tirno fill <selector|@N> <value>
tirno fill <selector|@N> --value-stdin  # 값을 stdin 에서. 인자로 준 값은 ps 에 남는다
tirno type <text> [--delay ms]
tirno press <key>                       # Enter, Tab, Escape, ArrowDown...
tirno press 'Meta+v'                    # 조합키. 편집 명령은 CDP commands 로 실제 실행된다
tirno press 'Shift+Tab'                 # 그 밖의 조합은 평범한 키 입력
tirno hover <selector|@N>
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
tirno eval "<expr>" --timeout 60000     # 기본 30초. 0 이면 연결이 허용하는 만큼
tirno eval '() => { …; return x }'      # 인자 없는 함수는 호출하고 반환값을 낸다
```

함수 리터럴을 넘기면 **호출한다.** 안 부르면 함수 객체가 `{}` 로 직렬화되어 "빈 결과" 로
읽힌다. 인자를 받는 함수는 부르지 않고 그렇게 말한다(exit 1).

settle 하지 않는 promise 를 페이지가 돌려주면 기본 30초에서 끊고 그렇게 말한다 —
`navigator.clipboard.readText()` 가 권한 없이 그렇게 된다. 페이지 쪽 실행을 멈추지는 않는다.

**셀렉터는 열린 shadow root 를 관통한다.** `click`·`fill`·`hover`·`wait-for` 는 light DOM 에서
먼저 찾고, 없으면 열린 shadow root 를 순회한다. light 를 먼저 보는 것이 규약이다 — 같은 셀렉터가
양쪽에 있을 때 관통 쪽은 shadow 를 먼저 고르므로, 그것만 쓰면 지금까지 눌리던 요소가 바뀐다(실측).
닫힌 shadow root 는 대상이 아니다.

### document-start 훅

```bash
tirno inject add 'window.__t0 = Date.now()'   # 인자
tirno inject add --file ./hook-xhr.js         # 파일
cat ./hook-xhr.js | tirno inject add          # stdin
tirno inject ls [--json]
tirno inject rm <id>                          # 인자 없으면 전부
```

`eval` 은 페이지가 로드된 **뒤**에 돈다. 부팅 중에 이미 나간 요청을 잡거나 페이지가
리스너를 걸기 전에 가드를 심으려면 그보다 먼저 돌아야 한다 — 그 자리가 `inject` 다.
`cdp Page.addScriptToEvaluateOnNewDocument` 로 직접 등록하면 identifier 까지 돌려받고도
그 명령이 끝나는 순간 사라진다. `inject` 는 소스를 세션 메타에 저장하고 connect 마다
다시 걸어 재기동까지 넘긴다. 등록은 현재 문서를 건드리지 않으니 지금 보려면 `reload`.

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

### 권한

```bash
tirno permissions grant https://example.com clipboard-read clipboard-write
tirno permissions revoke https://example.com   # origin 생략하면 전부 해제
tirno permissions ls                            # 이 세션에 기록된 grant
tirno perm ls                                   # 줄임말
```

CDP 권한은 프로필이 아니라 **DevTools 연결에 묶인다.** tirno 는 명령마다 붙었다 끊으므로
`cdp Browser.grantPermissions` 로 직접 준 권한은 그 명령이 끝나면 `prompt` 로 돌아간다 —
user-data-dir 을 유지해도 그렇다. `permissions grant` 는 `SessionMetadata.permissions` 에
저장하고 emulation 과 같은 자리에서 connect 마다 재적용한다.

클립보드는 권한만으로 부족하다. 문서에 포커스가 없으면 `readText()` 가
`NotAllowedError: Document is not focused` 로 거절되므로, 백그라운드 탭이면
`tirno cdp Page.bringToFront '{}'` 를 먼저 보낸다.

### 고정 헤더

```bash
tirno headers set X-Debug 1                       # 모든 요청, 유지된다
tirno headers set X-Key abc --host api.acme.com   # 그 호스트만 (반복 가능)
tirno headers set X-Key abc --once                # tirno 명령이 도는 동안만
tirno headers rm X-Key                            # 하나, 인자 없으면 전부
tirno headers ls                                  # 두 벌 다, 범위와 함께
```

경로가 둘이고 `--once` 로 갈린다.

기본은 세션 프로필 안(`<user-data-dir>/tirno-headers`)에 굽는 declarativeNetRequest 확장이다.
규칙이 브라우저 네트워크 스택에 걸리므로 **CDP 연결이 끊긴 뒤에도 유지되고**, 서비스워커와
OOPIF 가 스스로 보내는 요청에도 붙는다. `--host` 는 등록 가능 도메인 기준이라 서브도메인이
함께 걸린다. 세션이 `--extensions` 로 떠 있어야 하고, 아니면 명령이 재기동을 안내하며 거절한다.

`--once` 는 `Network.setExtraHTTPHeaders` 다. connect 마다 재적용하지만 연결 수명에 묶여
**tirno 명령이 도는 동안 나가는 요청에만** 붙는다 — 명령이 끝난 뒤 페이지가 스스로 보내는
요청에는 붙지 않는다. 호스트 조건도 받지 못한다. `--extensions` 없이 뜬 세션에서 쓸 수 있는
것은 이쪽뿐이다.

확장은 `Extensions.loadUnpacked` 로만 들어간다 — `--load-extension` 은 chrome 152 에서 죽은
경로다(플래그가 커맨드라인에 실려도 붙지 않는다). 그렇게 심은 확장은 프로필에도 남지 않아
`restart` 가 기동 뒤 다시 읽힌다. 저장된 규칙이 있으면 `--extensions` 를 다시 적지 않아도
켜지고, 확장은 브라우저보다 늦게 붙으므로 부트 URL 은 규칙이 들어간 뒤 한 번 재로드한다.

### 서비스워커 — 무엇이 프록시되고 있나

```bash
tirno sw status              # 등록된 워커 + Cache Storage 의 경로 수 + (있으면) sw-proxy 레이어
tirno sw status --paths      # 캐시된 경로를 전부 나열
tirno sw status --json
```

정본은 **등록 정보와 Cache Storage** 다. sw-proxy 의 `<scope>__tirno/status` 만 믿으면 안 된다 —
워커는 자기 스크립트를 내주던 로컬 서버보다 오래 살고, 프로필에는 tirno 가 굽지 않은 워커도
들어 있을 수 있다. 실측한 세션에서는 스크립트가 origin 에서 404 이고 control 요청에 사이트의
HTML 이 돌아왔는데, 프록시되는 경로 22개는 Cache Storage 에 남아 계속 서빙되고 있었다.
control 응답은 답하는 워커에 한해 레이어별 `enabled` · `fetched` · `paths` 로 얹는다. fetched 는 이번 SW 인스턴스의 fetch 처리 횟수라 캐시 히트/bfcache 로드엔 0 이다 — 덮임 여부는 paths(Cache Storage 적재분)로 본다.

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
tirno cdp <method> [params]           # 3번. 모든 CDP 명령 raw passthrough
tirno trail capture|ls|show           # 5번. 마지막 보루 — 사용자 시연을 받는다
tirno record start|stop               # 사용자 입력 캡처
tirno replay <name>                   # 신뢰 이벤트로 재생. 채널 순서대로 폴백
```

**OCR 채널은 없다.** 2026-08-19 에 들어냈다 — `onnxruntime` 259MB 를 끌고 오는데 이
머신에서 한 번도 안 돌았다. 되살릴 때는 플러그인으로 붙인다.


### 자기 기술 — 에이전트는 `--help` 를 긁지 말 것

```bash
tirno schema [--pretty]          # 명령 트리 전체를 JSON 으로 (The CLI Spec v0.3)
```

`--help` 은 사람용 산문이라 서브커맨드 27개가 최상위에 안 보이고, 여러 줄 설명이
명령 목록과 섞여 파싱하면 없는 플래그가 나온다. `schema` 는 commander 트리에서
자동 생성되므로 CLI 와 어긋날 수 없다. 엔드포인트마다 다음을 선언한다:

- `effects` — `read_only` / `idempotent` / `non_idempotent`
- `destructive` — **되돌릴 수 없이 뭔가를 없앤다**: `kill` `gc` `restart` `close-tab`
  `cache prune` `trail rm` `record rm`. 실행 전에 이걸 보면 된다
- `passthrough` — `-- <chrome flags>` 를 받는 명령(`new` `restart` `drift`)
- `args` / `options` / `cardinality` / `output_kind`

### 부수

```bash
tirno stats                      # ~/.tirno/metrics.jsonl 집계
tirno update [--check]           # 최신 릴리즈로 — 바이너리 + 스킬 플러그인
```

`update` 는 bun 으로 컴파일한 단일 실행 파일일 때만 바이너리를 갈아 낀다(소스 체크아웃은
`git pull && npm run build`). 받은 파일은 `SHA256SUMS` 와 대조하고 어긋나면 설치하지 않는다.
스킬은 `claude plugin marketplace update tirno` → `claude plugin update tirno@tirno` 로 당긴다 —
파일을 직접 만지면 Claude Code 가 들고 있는 플러그인 상태와 어긋난다. 바이너리와 플러그인은
따로 낡으므로 각각 판정한다(`--check` 가 두 줄로 보고한다).

## 세션 메타데이터

`~/.tirno/sessions/<name>.json`에 저장:
- PID, port, wsEndpoint, userDataDir, chromeFlags, createdAt, lastAccessedAt
- emulation: { device, viewport, network, cpu }
- permissions: origin → 허용 목록. connect 마다 재적용한다
- headerRules: 확장으로 나가는 고정 헤더. 재기동이 다시 읽힌다
- extraHeaders: `headers set --once` 로 건 헤더. connect 마다 재적용한다
- extensions: `--extensions` 로 떴는가. `headers set` 이 이 값으로 판정한다

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
