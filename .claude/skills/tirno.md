# tirno

Multi-session browser automation CLI on raw CDP.
여러 Chrome 인스턴스를 세션으로 관리하고, CDP 명령을 보낸다.

## 사용법

```
/tirno <command> [args]
```

## 설치

```bash
cd ~/rockheung/chromux
npm install && npm run build
npm link   # 또는 PATH에 bin/ 추가
```

## 세션 관리

```bash
tirno new <name> [-- chrome-flags...]    # Chrome 세션 생성
tirno ls [--json]                         # 세션 목록 (EMULATION 컬럼 포함)
tirno attach <name>                       # 활성 세션 설정
tirno kill <name|--all> [--clean]         # 세션 종료
tirno rename <old> <new>                  # 세션 이름 변경
tirno export <name>                       # 세션 설정 JSON 출력
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
tirno pages [--json]               # 탭 목록
tirno select <pageId>              # 탭 선택
tirno new-tab [url]                # 새 탭
tirno close-tab <pageId>           # 탭 닫기
```

### 조사

```bash
tirno screenshot [--out path] [--full] [--format png|jpeg|webp]
tirno snapshot [--verbose]         # a11y 트리. 노드마다 @N ref 부여, ~/.tirno/refs/<session>.json에 저장
tirno console [--type error|warn]  # 콘솔 메시지 (stateless 한계 — 캡처 시점만)
tirno network [--type xhr|fetch]   # 네트워크 요청 (reload 후 2초간 캡처)
```

### 입력

```bash
tirno click <selector|@N> [--dbl]      # selector 또는 @N ref (snapshot에서 부여된 번호)
tirno fill <selector|@N> <value>
tirno type <text> [--delay ms]
tirno press <key>                       # Enter, Tab, Escape, ArrowDown...
tirno hover <selector>
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

### 성능

```bash
tirno trace [--duration <s>] [--out <path>]   # 단일 명령으로 N초간 트레이스 후 저장 (기본 5초)
tirno memory [--out path]                      # 힙 스냅샷 (DevTools Memory 탭에서 열기)
```

### 멀티세션

```bash
tirno diff <s1> <s2> [--out path]   # 두 세션 스크린샷 시각 비교 (pixelmatch)
tirno broadcast <command> [args]    # 모든 세션에 명령 실행
```

## 세션 메타데이터

`~/.tirno/sessions/<name>.json`에 저장:
- PID, port, wsEndpoint, userDataDir, chromeFlags, createdAt, lastAccessedAt
- emulation: { device, viewport, network, cpu }

`~/.tirno/profiles/<name>/` — 세션별 Chrome 프로필 디렉토리.
`~/.tirno/active` — 현재 활성 세션 이름.
`~/.tirno/refs/<name>.json` — snapshot에서 부여된 @ref → backendDOMNodeId 매핑.

## 포트 할당

기본 범위 9222-9322. 기존 세션과 충돌 없이 자동 할당.
`--port <n>` 옵션으로 지정 가능.

## 주의사항

- Chrome이 설치되어 있어야 함 (`/Applications/Google Chrome.app` 또는 `--executable-path`)
- `tirno kill`은 Chrome 프로세스만 종료. `--clean`으로 프로필 디렉토리도 삭제.
- `tirno ls`에서 `dead` 상태 세션은 Chrome이 이미 종료된 것. `tirno kill <name>`으로 정리.
- 명령마다 CDP 연결 → 실행 → 연결 해제. Chrome은 독립 실행 유지.
- @ref는 snapshot 직후에만 유효. 페이지가 바뀌면 snapshot 다시.
