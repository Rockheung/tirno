# wandr

Multi-session browser automation CLI on raw CDP.
여러 Chrome 인스턴스를 세션으로 관리하고, CDP 명령을 보낸다.

## 사용법

```
/wandr <command> [args]
```

## 설치

```bash
cd ~/rockheung/chromux
npm install && npm run build
npm link   # 또는 PATH에 bin/ 추가
```

## 세션 관리

```bash
wandr new <name> [-- chrome-flags...]    # Chrome 세션 생성
wandr ls [--json]                         # 세션 목록 (EMULATION 컬럼 포함)
wandr attach <name>                       # 활성 세션 설정
wandr kill <name|--all> [--clean]         # 세션 종료
wandr rename <old> <new>                  # 세션 이름 변경
wandr export <name>                       # 세션 설정 JSON 출력
```

세션 = 독립된 Chrome 프로세스. 각각 고유한 포트, user-data-dir, Chrome 플래그를 가짐.
`--` 뒤에 Chrome 플래그를 전달:

```bash
wandr new sandweb -- --no-proxy-server --ignore-certificate-errors \
  --host-resolver-rules="MAP *.internal-test.example 127.0.0.1"

wandr new mitmproxy -- --proxy-server=http://127.0.0.1:8888

wandr new mobile -- --window-size=375,812
```

## CDP 명령

모든 CDP 명령에 `-s <session>` 옵션. 생략하면 `wandr attach`로 설정한 활성 세션 사용.

### 탐색

```bash
wandr nav <url> [-s session]       # URL 이동
wandr reload [--hard]              # 새로고침
wandr back / forward               # 히스토리
wandr pages [--json]               # 탭 목록
wandr select <pageId>              # 탭 선택
wandr new-tab [url]                # 새 탭
wandr close-tab <pageId>           # 탭 닫기
```

### 조사

```bash
wandr screenshot [--out path] [--full] [--format png|jpeg|webp]
wandr snapshot [--verbose]         # a11y 트리. 노드마다 @N ref 부여, ~/.wandr/refs/<session>.json에 저장
wandr console [--type error|warn]  # 콘솔 메시지 (stateless 한계 — 캡처 시점만)
wandr network [--type xhr|fetch]   # 네트워크 요청 (reload 후 2초간 캡처)
```

### 입력

```bash
wandr click <selector|@N> [--dbl]      # selector 또는 @N ref (snapshot에서 부여된 번호)
wandr fill <selector|@N> <value>
wandr type <text> [--delay ms]
wandr press <key>                       # Enter, Tab, Escape, ArrowDown...
wandr hover <selector>
wandr upload <selector> <files...>
wandr scroll <up|down|<pixels>> [--step <px>]
wandr wait <ms>                         # 단순 sleep
wandr wait-for <selector> [--timeout ms]
wandr wait-for --network-idle [--timeout ms]
```

### 평가

```bash
wandr eval <expression>
wandr eval "document.title"
wandr eval "JSON.stringify(performance.timing)" --json
```

### 에뮬레이션

```bash
wandr emulate --device "iPhone 14"
wandr emulate --network slow-3g     # slow-3g, fast-3g, 4g, offline
wandr emulate --cpu 4               # 4x CPU 감속
wandr emulate --dpr 2               # device pixel ratio 단독 또는 device와 조합
wandr emulate --reset               # emulation 해제
wandr emulate --list-devices        # 프리셋 목록
```

emulation 상태는 `SessionMetadata.emulation`에 저장되어 connect마다 자동 재적용 (`page.emulate()` 사용으로 UA/touch도 새 connection에서 유지).

### 성능

```bash
wandr trace [--duration <s>] [--out <path>]   # 단일 명령으로 N초간 트레이스 후 저장 (기본 5초)
wandr memory [--out path]                      # 힙 스냅샷 (DevTools Memory 탭에서 열기)
```

### 멀티세션

```bash
wandr diff <s1> <s2> [--out path]   # 두 세션 스크린샷 시각 비교 (pixelmatch)
wandr broadcast <command> [args]    # 모든 세션에 명령 실행
```

## 세션 메타데이터

`~/.wandr/sessions/<name>.json`에 저장:
- PID, port, wsEndpoint, userDataDir, chromeFlags, createdAt, lastAccessedAt
- emulation: { device, viewport, network, cpu }

`~/.wandr/profiles/<name>/` — 세션별 Chrome 프로필 디렉토리.
`~/.wandr/active` — 현재 활성 세션 이름.
`~/.wandr/refs/<name>.json` — snapshot에서 부여된 @ref → backendDOMNodeId 매핑.

## 포트 할당

기본 범위 9222-9322. 기존 세션과 충돌 없이 자동 할당.
`--port <n>` 옵션으로 지정 가능.

## 주의사항

- Chrome이 설치되어 있어야 함 (`/Applications/Google Chrome.app` 또는 `--executable-path`)
- `wandr kill`은 Chrome 프로세스만 종료. `--clean`으로 프로필 디렉토리도 삭제.
- `wandr ls`에서 `dead` 상태 세션은 Chrome이 이미 종료된 것. `wandr kill <name>`으로 정리.
- 명령마다 CDP 연결 → 실행 → 연결 해제. Chrome은 독립 실행 유지.
- @ref는 snapshot 직후에만 유효. 페이지가 바뀌면 snapshot 다시.
