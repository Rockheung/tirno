# chromux

tmux-style Chrome DevTools Protocol CLI.
여러 Chrome 인스턴스를 세션으로 관리하고, CDP 명령을 보낸다.

## 사용법

```
/chromux <command> [args]
```

## 설치

```bash
cd ~/rockheung/chromux
npm install && npm run build
npm link   # 또는 PATH에 bin/ 추가
```

## 세션 관리

```bash
chromux new <name> [-- chrome-flags...]    # Chrome 세션 생성
chromux ls [--json]                         # 세션 목록
chromux attach <name>                       # 활성 세션 설정
chromux kill <name|--all> [--clean]         # 세션 종료
chromux rename <old> <new>                  # 세션 이름 변경
chromux export <name>                       # 세션 설정 JSON 출력
```

세션 = 독립된 Chrome 프로세스. 각각 고유한 포트, user-data-dir, Chrome 플래그를 가짐.
`--` 뒤에 Chrome 플래그를 전달:

```bash
chromux new sandweb -- --no-proxy-server --ignore-certificate-errors \
  --host-resolver-rules="MAP *.internal-test.example 127.0.0.1"

chromux new mitmproxy -- --proxy-server=http://127.0.0.1:8888

chromux new mobile -- --window-size=375,812
```

## CDP 명령

모든 CDP 명령에 `-s <session>` 옵션. 생략하면 `chromux attach`로 설정한 활성 세션 사용.

### 탐색

```bash
chromux nav <url> [-s session]       # URL 이동
chromux reload [--hard]              # 새로고침
chromux back / forward               # 히스토리
chromux pages [--json]                # 탭 목록
chromux select <pageId>               # 탭 선택
chromux new-tab [url]                 # 새 탭
chromux close-tab <pageId>            # 탭 닫기
```

### 조사

```bash
chromux screenshot [--out path] [--full] [--format png|jpeg|webp]
chromux snapshot [--verbose]          # A11y 트리
chromux console [--type error|warn]   # 콘솔 메시지
chromux network [--type xhr|fetch]    # 네트워크 요청
```

### 입력

```bash
chromux click <selector> [--dbl]
chromux fill <selector> <value>
chromux type <text> [--delay ms]
chromux press <key>                   # Enter, Tab, Escape, ArrowDown...
chromux hover <selector>
chromux upload <selector> <files...>
```

### 평가

```bash
chromux eval <expression>
chromux eval "document.title"
chromux eval "JSON.stringify(performance.timing)" --json
```

### 에뮬레이션

```bash
chromux emulate --device "iPhone 14"
chromux emulate --network slow-3g     # slow-3g, fast-3g, 4g, offline
chromux emulate --cpu 4               # 4x CPU 감속
chromux emulate --list-devices        # 프리셋 목록
```

### 성능

```bash
chromux trace start                   # 트레이스 시작
chromux trace stop [--out path]       # 트레이스 저장 (chrome://tracing에서 열기)
chromux memory [--out path]           # 힙 스냅샷 (DevTools Memory 탭에서 열기)
```

### 멀티세션

```bash
chromux diff <s1> <s2> [--out path]   # 두 세션 스크린샷 시각 비교 (pixelmatch)
chromux broadcast <command> [args]    # 모든 세션에 명령 실행
```

## 세션 메타데이터

`~/.chromux/sessions/<name>.json`에 저장:
- PID, port, wsEndpoint, userDataDir, chromeFlags, createdAt

`~/.chromux/profiles/<name>/` — 세션별 Chrome 프로필 디렉토리.
`~/.chromux/active` — 현재 활성 세션 이름.

## 포트 할당

기본 범위 9222-9322. 기존 세션과 충돌 없이 자동 할당.
`--port <n>` 옵션으로 지정 가능.

## 주의사항

- Chrome이 설치되어 있어야 함 (`/Applications/Google Chrome.app` 또는 `--executable-path`)
- `chromux kill`은 Chrome 프로세스만 종료. `--clean`으로 프로필 디렉토리도 삭제.
- `chromux ls`에서 `dead` 상태 세션은 Chrome이 이미 종료된 것. `chromux kill <name>`으로 정리.
- 명령마다 CDP 연결 → 실행 → 연결 해제. Chrome은 독립 실행 유지.
