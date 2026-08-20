# Anchor broker — 디버그 포트가 아니라 디렉토리를 앵커로

> tirno 세션을 브라우저 MCP(`chrome-devtools-mcp`)의 안정적인 접속 대상으로 만들고,
> "어느 포트에 뭐가 살아있고 그게 내 것인지"를 관찰로 판정하는 계층의 설계.
>
> 조사·작성: 2026-08-14 · 상태: **구현 완료** (#41 · #42). 설계 근거의 기록으로 보존한다.
> 실행 계획은 [plan-anchor-broker.md](./plan-anchor-broker.md).

---

## 0. 이 문서를 읽는 법

주장은 셋으로 라벨링돼 있다. 섞어 읽지 말 것.

| 라벨 | 뜻 |
|---|---|
| **[측정]** | 이 머신에서 명령을 돌려 출력을 확인함. 출력 원문을 함께 적었다. |
| **[코드]** | 소스를 열어 로직을 확인함. 파일·줄 번호를 적었다. 실행으로 재현하진 않았다. |
| **[가정]** | 아직 확인 안 됨. Gate 로 승격해 plan 문서에서 검증한다. |

**이 설계의 결론은 [가정] 하나(Gate 1)에 전부 걸려 있었다.** → **2026-08-14 Gate 1·2·3
통과.** 실행 출력은 [plan §7](./plan-anchor-broker.md#7-gate-결과-기록-append-only).
§7 fallback(포트 앵커 + 데몬)은 불필요해졌다. Gate 4 에서 §4 의 [가정] 하나가
**반증**됐으므로 아래 §4 한계 항목을 함께 읽을 것.

---

## 1. 풀려는 문제

tirno 는 이미 multi-session Chrome 관리자다. 그런데 세션이 **브라우저 MCP 의 접속
대상**이 되는 순간, 그리고 세션이 **오래 살아남는** 순간 세 가지가 동시에 깨진다.

### 1.1 대장(`~/.tirno/sessions/*.json`)과 현실이 어긋난다

세션 메타는 "기동 시점의 주장"이지 현재 사실이 아니다. Chrome 이 죽어도, 재기동해서
포트가 바뀌어도, 남이 그 포트를 뺏어가도 파일은 그대로다. 특히 `wsEndpoint` 는
기동 시점 값을 박아두므로 Chrome 이 한 번이라도 재기동하면 조용히 stale 이 된다.

### 1.2 생사 판정이 `kill -0 pid` 하나다

`chrome-connector.ts:14` 의 `if (!isAlive(meta.pid))` 가 전부다. pid 는 재사용되고,
포트는 다른 프로세스가 물려받는다. `/json/version` 이 200 을 주고 자기를 Chrome 이라
말해도 **내 Chrome 이라는 증거가 아니다.**

### 1.3 고정 포트 할당이 충돌을 구조로 만든다

`port-allocator.ts` 는 `PORT_MIN 9222`부터 훑는다. 실제 리스너를 프로브하는 점은
옳지만(splicer 의 메타-only 방식보다 낫다), **9222 대역은 남들도 쓰는 대역**이다.
그리고 MCP 를 `--browser-url=http://127.0.0.1:<port>` 로 붙이는 순간 그 번호가
설정에 박혀서, 세션이 재기동되면 따라가지 못한다.

---

## 2. 근거 — 이 머신에서 실제로 깨져 있던 것

### 2.1 인벤토리 스냅샷 **[측정: 2026-08-10]**

```
9333  LISTEN  Google Chrome pid 15057      (splicer 대장: default/pid 15057)   → 일치
9225  리스너 없음, pid 82569 없음            ~/.tirno 대장: 살아있는 세션        → 유령 엔트리
9222  LISTEN  OtherAgentApp pid 1285  ~/.tirno 대장: "legacy-widget-session" pid 68429(죽음)
```

9222 가 핵심 증거다.

```
$ lsof -nP -iTCP:9222 -sTCP:LISTEN
COMMAND    PID     USER   FD   TYPE  ... NAME
OtherAgentA 1285 me   39u  IPv4  ... TCP 127.0.0.1:9222 (LISTEN)

$ ps -o command= -p 1285
/Applications/OtherAgentApp.app/Contents/MacOS/OtherAgentApp

$ curl -s http://127.0.0.1:9222/json/version | head -3
{
   "Browser": "Chrome/120.0.6099.109",
   ...

$ curl -s http://127.0.0.1:9222/json/list | jq -r '.[] | "\(.type)\t\(.title)\t\(.url)"'
page	OtherApp	https://internal-db-proxy.example/login
```

9222 는 **Electron 앱(OtherApp 데스크톱)의 디버그 포트**였고, 그 안에 프로덕션 DB
프록시 로그인 탭이 열려 있었다. tirno 대장은 그걸 자기 세션이라고 적어두고 있었다.

두 가지 실패 모드가 여기서 나온다.

- **오접속** — `tirno` 가 그 세션 이름으로 connect 하면 프로덕션 DB 프록시 클라이언트를
  원격조종하게 된다. CDP 는 쿠키·세션·DOM 전권이다. 지금 코드에서 이걸 막는 건
  `isAlive(68429)` 가 false 라는 우연뿐이다 — pid 가 재사용됐다면 그대로 뚫린다.
- **오살해** — "정리"한다고 죽이면 2026-07-07 크롬 오귀속 사고(kill + 프로필 rm 으로
  로그인 세션 소실)의 정확한 재연이다.

**교훈: `/json/version` 200 = 살아있음 ≠ 내 것.**

### 2.2 대장은 "어떻게 떴는지"도 보장하지 않는다 **[측정: 2026-08-10]**

9333 Chrome 의 실제 커맨드라인에는 `--remote-debugging-address=127.0.0.1` 이 있는데,
그 Chrome 을 띄웠다고 기록된 도구의 어느 체크아웃에도 그 플래그가 없었다. 메타의
`port`/`pid` 가 맞아도 **실행 옵션은 별개로 확인해야 한다.** tirno 는
`chromeFlags` 를 저장하지만 그것도 "기동 시 우리가 준 것"이지 "지금 돌고 있는 것"이
아니다.

---

## 3. 설계를 결정한 실측 두 가지

### 3.1 MCP 는 툴 호출마다 재연결한다 **[코드]**

`chrome-devtools-mcp` (`~/.npm/_npx/15c61037b1978c83/node_modules/chrome-devtools-mcp/build/src/`).
조사 시점 1.6.0, **Gate 검증 시점(2026-08-14)엔 같은 경로가 1.7.0** — 아래 두 분기는
1.7.0 에서도 동일함을 소스로 재확인했다:

- `index.js:81` — 모든 툴 핸들러가 `getContext()` 를 거치고 그 안에서
  `ensureBrowserConnected()` 를 호출한다. 연결은 **lazy** — 서버 기동 시점에 붙지 않는다.
  대상이 없어도 MCP 서버 자체는 정상적으로 뜬다.
- `browser.js:35` — `if (browser?.connected) return browser;`
  끊겨 있으면 그 자리에서 **다시 붙는다.** 소스에 `reconnected: context !== undefined`
  주석까지 있다 ("Surfaces a one-time note in the next response after a reconnect").

→ **MCP 를 재시작하지 않고 Chrome 을 갈아끼울 수 있다.**

### 3.2 Chrome 은 포트 0 일 때만 `DevToolsActivePort` 를 쓴다 **[측정: 2026-08-14]**

Chrome 151, headless, 격리 프로필, PID 로 정확히 종료.

```
--remote-debugging-port=0      →  DevToolsActivePort 있음
                                  "61883\n/devtools/browser/7df93a26-3262-48ee-85eb-8ac4d725da03"

--remote-debugging-port=9411   →  DevToolsActivePort 없음
```

그리고 `browser.js:57-82` **[코드]** — MCP 에 `--user-data-dir` 이 주어지면 **매 연결마다**
그 디렉토리의 `DevToolsActivePort` 를 다시 읽어 `ws://127.0.0.1:<port><path>` 를 조립한다.

CLI 옵션 충돌 관계 **[코드: `bin/chrome-devtools-mcp-cli-options.js`]**:

- `autoConnect` conflicts `['isolated', 'executablePath']`
- `userDataDir` conflicts `['browserUrl', 'wsEndpoint', 'isolated']`
- → **`--auto-connect --user-data-dir=<dir>` 조합은 허용된다.**

`index.js:81` 분기상 `autoConnect` 가 참이어야 `ensureBrowserConnected` 로 가고,
`browser.js` 안에서 `userDataDir` 분기가 `channel` 보다 우선한다.

### 3.3 깨진 가정 하나 — 기록해 둔다

처음엔 "기존에 떠 있는 Chrome 에 그대로 적용하면 된다"고 생각했다. **틀렸다.**
당시 살아있던 프로필(Chrome 151 구동 중)에 `DevToolsActivePort` 가 **없었다** —
고정 포트로 띄웠기 때문이다 **[측정: 2026-08-14]**. `~/.tirno/profiles/*` 전수 확인에서도
`DevToolsActivePort` 는 **하나도 없었다** — tirno 가 항상 고정 포트로 띄워왔기 때문이다.

→ 이 설계는 **기동 방식을 `--remote-debugging-port=0` 으로 바꾸는 것이 전제**다.
기존 세션에 소급 적용되지 않는다. 마이그레이션 경로는 plan 문서 §5 참조.

---

## 4. 설계 — 앵커를 포트가 아니라 디렉토리로

```
MCP 설정 (client 무관 — Claude Code / codex / opencode 동일):
  npx -y chrome-devtools-mcp@latest \
      --auto-connect \
      --user-data-dir=/Users/<me>/.tirno/anchors/main

앵커:
  ~/.tirno/anchors/main   ──symlink──▶   ../profiles/<세션 이름>

모든 Chrome 기동:
  --remote-debugging-port=0        (OS 가 포트 할당, Chrome 이 파일에 기록)
```

`~/.tirno/` 레이아웃 확장:

```
~/.tirno/
  sessions/<name>.json      기존 — 대장(라벨). 진실 아님
  profiles/<name>/          기존 — 영속 user-data-dir
    DevToolsActivePort      NEW  — Chrome 이 쓰는 진실. port + ws path
  anchors/<anchor>/         NEW  — profiles/<name> 로의 symlink. MCP 가 가리키는 곳
  active                    기존 — CLI 기본 세션
```

**`active`(CLI 용)와 `anchors/*`(MCP 용)는 별개다.** 섞으면 CLI 로 세션을 바꿨더니
MCP 대상이 따라 바뀌는 사고가 난다. 의도적으로 분리한다.

### 왜 이게 문제를 없애는가

| 기존 문제 | 앵커-디렉토리에서 |
|---|---|
| 포트 충돌 / 9222 대역 경합 | **소멸.** OS 가 고르고 Chrome 이 적는다. 번호를 예약할 필요가 없다 |
| Chrome 재기동 시 포트 변경 | **자동 추적.** 다음 툴 호출이 파일을 다시 읽는다 |
| 하나의 포트에만 MCP 가능 | **앵커 N개.** `anchors/main`, `anchors/wt-foo` … 디렉토리는 충돌하지 않는다 |
| 상시 데몬 필요 | **불필요.** 중계도 프록시 홉도 없다. tirno 의 stateless CLI 철학 유지 |
| `wsEndpoint` stale | 파일이 진실. 메타의 `wsEndpoint` 는 캐시 힌트로 강등 |

특히 "앵커 N개"가 크다. 포트 앵커에서는 worktree 병렬 검증을 하려면 WS 릴레이로
핫스왑을 구현해야 했는데, 디렉토리 앵커에서는 MCP 엔트리를 하나 더 쓰면 끝이다.
**릴레이를 지을 이유가 사라진다.**

### 한계 — 정직하게

- **핫스왑은 안 된다.** 이미 연결된 MCP 는 심링크를 바꿔도 즉시 옮겨가지 않는다
  (`browser.js:35` 가 `connected` 인 browser 를 캐시한다). `tirno anchor set` 은
  "심링크 교체 + 선택적 이전 Chrome 종료(`--evict`)" 여야 실제로 전환된다.
  앵커를 여러 개 두면 전환할 일 자체가 줄어든다.
- **종료하면 stale 파일이 남는다 — 예외 없이.** ~~Chrome 은 정상 종료 시 지우지만
  크래시하면 남는다~~ → **반증됨 [측정: 2026-08-14, Gate 4]**. SIGTERM·SIGKILL·CDP
  `Browser.close`(graceful) **셋 다 파일을 남긴다.** tirno 의 `killAndWait` 이 앞의 둘이므로
  tirno 로 죽인 세션은 항상 잔존물을 남긴다 → 종료 경로에서 직접 지운다(plan Stage 1).
  다만 **stale 파일로 오접속은 불가능하다** — 파일의 browser UUID 가 인스턴스 식별자라
  다른 브라우저가 그 포트를 재사용해도 `404` 로 튕긴다 **[측정: Gate 4c]**. 즉 2.1 의
  9222/OtherApp 오접속은 이 방식에서 구조적으로 재연 불가능하다. 고정 포트 +
  `--browser-url` 에는 이 방어막이 없다.
- **`DevToolsActivePort` 는 문서화된 계약이 아니다.** 관측된 동작이다. Chrome 업데이트로
  바뀔 수 있으므로 회귀 테스트가 필요하다(plan §4 T3).
- **MCP 가 붙을 대상이 없으면 자동 기동되지 않는다.** 데몬이 없으므로 아무도 대신
  띄워주지 않는다. 에러 메시지는 명확하다(`Could not connect to Chrome in <dir>`).
  이건 설계상 의도 — 암묵 기동보다 명시 기동이 낫다.

---

## 5. 브로커가 하는 일

데몬이 없으므로 남는 것은 **CLI 표면**이다.

### 5.1 launch — port 0 로

기존 `tirno new <name> [-- <flags>]` 를 유지하되 `--remote-debugging-port=0` 으로 띄우고,
기동 후 `profiles/<name>/DevToolsActivePort` 를 읽어 실제 포트를 확정한다.
라우팅 규칙(`--host-resolver-rules` 등)은 **호출자가 주는 플래그일 뿐** — tirno 는 그
의미를 모른다. 이게 특정 라우팅 도구(splicer/sandweb 등)에 대한 의존을 없애는 지점이고,
`wishs.md` 의 sandweb 시나리오와도 그대로 정합한다.

### 5.2 inventory — 대장을 믿지 않는다

```
lsof -nP -iTCP -sTCP:LISTEN          # 리스너 열거
  → 포트별 GET /json/version         # --max-time 필수 (hang 방지)
  → 포트 점유 pid
  → ps 커맨드라인에서 --user-data-dir 파싱
```

대장(`sessions/*.json`)은 이름·그룹·emulation 같은 **라벨을 붙이는 용도로만** 조인한다.
생사 판정 근거로 쓰지 않는다.

### 5.3 ownership — 이 설계의 안전 핵심

**3중 일치일 때만 `ours`:**

1. pid 가 살아있고
2. **그 pid 가 그 포트를 LISTEN 하고 있고**
3. 커맨드라인의 `--user-data-dir` 이 `~/.tirno/profiles/` 하위일 것

하나라도 어긋나면 `foreign` → **목록에 표시만 하고 kill·purge 대상에서 영구 제외.**
OtherApp 케이스가 정확히 여기서 걸러진다.

같은 포트에 리스너가 둘이면(IPv4 + IPv6) `ambiguous` 로 마킹하고 **자동 조치 전면 금지.**
2026-07-07 오귀속 사고를 문서가 아니라 코드로 박는 부분이다.

`connect()` 는 이 판정이 `ours` 일 때만 진행한다. `foreign` 이면 **무엇에 붙으려 했는지를
포함해 거부**한다 — "9222 는 OtherAgentApp(pid 1285) 소유" 처럼.

### 5.4 gc — 되돌릴 수 있는 것만 자동으로

| 대상 | 조치 |
|---|---|
| 유령 대장 엔트리 (리스너 없음 ∧ pid 없음) | 자동 삭제 |
| stale `DevToolsActivePort` (파일 있음, 리스너 없음) | 자동 삭제 |
| orphan 프로필 (대장에 없는 디렉토리) | **목록화만** |
| 오래된 프로필 디렉토리 | `--older-than` + `--dry-run` 경유 |
| 앵커가 가리키는 프로필 / `active` 세션 | 명시 지정 없이 삭제 불가 |
| `foreign` / `ambiguous` | **어떤 경우에도 자동 조치 없음** |

프로필 삭제는 로그인 세션 소실이므로 보수적으로. `~/.tirno/profiles/` 하위 단일
세그먼트일 때만 지우는 경로 가드를 둔다.

### 5.5 drift (선택, 후순위)

세션에 선언된 `chromeFlags` vs 실행 중 Chrome 의 실제 커맨드라인 비교 → 경고.

`--host-resolver-rules` 는 launch-time 스냅샷이라 실행 중엔 못 고친다. 기존에는
재기동 비용이 커서 경고에서 그쳤지만, 앵커 방식에서는 재기동 비용이 사실상 0 이다 —
포트 경합 없음, 프로필 영속(로그인 유지), MCP 자동 재연결. 경고를 원클릭 재기동으로
승격할 수 있다. `wishs.md` 가 요청한 "세션 옵션 갱신"이 여기에 대응한다.

---

## 6. tirno 코드에 미치는 영향

| 파일 | 변경 |
|---|---|
| `src/core/chrome-launcher.ts` | `allocate()` 대신 `--remote-debugging-port=0`, 기동 후 `DevToolsActivePort` 판독 |
| `src/core/port-allocator.ts` | **역할 소멸** (신규 세션 기준). 레거시 경로용으로만 잔존 또는 제거 |
| `src/core/session-store.ts` | `wsEndpoint` → 캐시 힌트로 강등. `anchor` 관련 필드 추가 |
| `src/core/chrome-connector.ts` | `isAlive(pid)` 단일 판정 → 3중 일치 검사 |
| `src/core/process-guard.ts` | 유지 (판정의 1/3) |
| 신규 `src/core/inventory.ts` | lsof + probe + ps 파싱, ownership 분류 |
| 신규 `src/commands/anchor.ts` | `anchor ls/set/rm` |
| `src/commands/session.ts` | `ls` 에 ownership 컬럼, `gc` 서브커맨드 |

변경 지점 셋 중 **둘은 이번 실측이 드러낸 현존 버그**다 — stale `wsEndpoint`,
그리고 `isAlive` 단일 판정. 후자가 3중 일치였으면 9222/OtherApp 오귀속은 애초에
불가능했다.

---

## 7. 기각한 대안 — 포트 앵커 + 데몬 (Gate 1 실패 시 fallback)

첫 설계는 `127.0.0.1:9333` 을 데몬이 영구 점유하고 `/json/version` 에 현재 타깃의 실
`webSocketDebuggerUrl` 을 돌려주는 **리다이렉터**였다. puppeteer 가 그 문자열을 호스트
재작성 없이 그대로 쓴다는 것도 확인했다 **[코드: `third_party/index.js:67271`]** — 즉
기술적으로 성립한다. MCP 는 `--browser-url=http://127.0.0.1:9333` 으로 고정.

기각 이유:

- **상시 데몬이 필요하다.** 수명주기(launchd? 훅? 래퍼?)라는 문제를 새로 만든다.
  tirno 의 stateless CLI 철학과 정면으로 어긋난다.
- **핫스왑하려면 WS 릴레이까지 가야 한다.** 앵커 N개로 공짜인 걸 코드로 산다.
- **포트를 점유한다는 사실 자체가 문제의 일부였다.** 충돌 클래스를 없애는 대신 관리한다.

다만 **Gate 1 실패 시엔 이 안이 유일한 경로**였다. → **Gate 1 통과(2026-08-14)로 이 안은
불필요해졌다.** 기록으로만 남긴다. §5 의 inventory / ownership / gc 는 어느 안에서도
그대로 필요하므로 계획대로 진행한다.

---

## 8. 미검증 가정 목록

| # | 가정 | 상태 (2026-08-14) |
|---|---|---|
| 1 | `--auto-connect --user-data-dir=<dir>` 로 MCP 가 port-0 Chrome 에 실제로 붙는다 | **검증됨** — 고유 마커 탭으로 동일성까지 확인 (plan §7.1) |
| 2 | Chrome 재기동 후 MCP 재시작 없이 새 포트를 잡는다 | **검증됨** — 60057→60077, MCP 가 `reconnected` 노트 반환 (plan §7.2) |
| 3 | 앵커가 심링크여도 1·2 가 동일하다 | **검증됨** — 상대경로 심링크로 1·2 재현 (plan §7.3) |
| 4 | 크래시 시 `DevToolsActivePort` 잔존 형태와 에러 메시지 | **측정됨 — 일부 반증.** 크래시뿐 아니라 **모든** 종료 경로에서 잔존. 오접속은 UUID 가 차단 (plan §7.4) |
| 5 | `lsof` 파싱이 IPv6·이중 리스너·권한 없는 프로세스에서 견딘다 | **미검증** — Stage 2 구현 중 테스트로 흡수 |

검증 절차·순서·중단 조건은 [plan-anchor-broker.md](./plan-anchor-broker.md) §2.

---

## 부록 — 참고 지점

- `chrome-devtools-mcp` 소스: `~/.npm/_npx/15c61037b1978c83/node_modules/chrome-devtools-mcp/build/src/` (조사 1.6.0 → 검증 1.7.0)
- 48개 MCP 툴 ↔ tirno CLI 전수 매핑: [research-chrome-devtools-mcp-mapping.md](./research-chrome-devtools-mcp-mapping.md)
- sandweb 측 요구사항: `../wishs.md`
- 관련 사고 기록: `~/.claude/lessons.md` — "크롬 오귀속 kill+rm Incident (2026-07-07)"
