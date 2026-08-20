# Plan — Anchor broker 도입

> 설계 근거·실측은 [research-anchor-broker.md](./research-anchor-broker.md).
> 이 문서는 **무엇을 어떤 순서로 짓고, 언제 멈추는가**만 다룬다.
>
> 작성: 2026-08-14 · 상태: **Gate 1·2·3 통과 (2026-08-14) — Stage 1 착수 가능**

---

## 0. 한 줄 요약

Chrome 을 `--remote-debugging-port=0` 으로 띄우고, MCP 는 포트 대신
`~/.tirno/anchors/<name>` **디렉토리**를 가리키게 한다. tirno 는 그 위에서
**관찰로 소유권을 판정**하고 죽은 것만 치운다.

---

## 1. 원칙 — 이 플랜이 지키는 것

1. **Gate 를 통과하지 못한 단계는 짓지 않는다.** 설계 전체가 미검증 가정 하나에
   걸려 있다(§2 Gate 1). 그게 깨지면 코드가 아니라 설계를 고친다.
2. **파괴적 조치는 마지막에, 옵트인으로.** 프로필 삭제 = 로그인 세션 소실이다.
   Stage 4 이전에는 어떤 자동 삭제도 넣지 않는다.
3. **`foreign` 은 건드리지 않는다.** 예외 없음. 사용자가 이름을 직접 지정해도
   `~/.tirno/profiles/` 밖은 tirno 가 죽이지 않는다.
4. **기존 세션을 깨지 않는다.** 고정 포트로 떠 있는 레거시 세션은 계속 붙어야 한다(§5).
5. **각 Stage 는 독립적으로 가치가 있다.** 2에서 멈춰도 실익이 남는다.

---

## 2. Gate — 착수 전 검증

### Gate 1 (필수·차단) — MCP 가 port-0 Chrome 에 붙는가

**이게 이 플랜의 존폐다.** 30분이면 판정 난다.

```bash
# 1) 격리 프로필로 port 0 chrome 기동 (headless 아님 — 실제 사용 형태로)
D=~/.tirno/probe-anchor
mkdir -p "$D"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=0 --user-data-dir="$D" --no-first-run about:blank &

# 2) 파일 생성 확인
cat "$D/DevToolsActivePort"     # 기대: "<port>\n/devtools/browser/<uuid>"

# 3) MCP 를 앵커로 붙여 툴 1회 호출
#    .mcp.json:
#    npx -y chrome-devtools-mcp@latest --auto-connect --user-data-dir=<D 절대경로>
#    → list_pages 또는 take_snapshot 1회
```

- **통과** = 툴이 그 Chrome 의 탭을 반환한다.
- **실패** = 설계 §4 무효. → research 문서 §7 의 **포트 앵커 + 데몬(리다이렉터)** 으로
  전환하고 이 플랜을 다시 쓴다. §3 의 Stage 2(inventory/ownership)는 **어느 안에서도
  필요하므로 그대로 살린다.**

주의: MCP 서버 args 는 클라이언트 기동 시 고정이다. `$HOME` 전개를 기대하지 말고
**절대경로**로 적는다. 재기동 필요.

### Gate 2 — 재기동 추적

Gate 1 통과 후, 그 Chrome 을 **PID 로** 종료 → 같은 프로필로 port 0 재기동 →
**MCP 재시작 없이** 툴 1회 호출.

- 통과 = 새 포트를 잡는다 (`browser.js:35` 재연결 경로 실증).
- 실패 = 핵심 이득 상실. Stage 1 은 의미가 남지만(충돌 소멸) 재평가 필요.

### Gate 3 — 심링크 투과

앵커를 `profiles/<name>` 로의 **symlink** 로 바꾸고 Gate 1·2 재실행.

- 실패 = 심링크 대신 "앵커 디렉토리 자체를 프로필로 쓰고 세션을 그 안에 배치" 또는
  MCP 설정 재작성 방식으로 변경.

### Gate 4 — 크래시 잔존물

Chrome 을 `kill -9` → `DevToolsActivePort` 가 남는지, 남은 파일로 MCP 가 어떤 에러를
내는지 기록. GC 규칙(Stage 4)의 입력이다. **차단 게이트 아님** — 관측만.

### Gate 5 — `lsof` 파싱 견고성

IPv4/IPv6 동시 리스너, 권한 없는 프로세스, 포트 재사용 상황에서 파서가 죽지 않는지.
Stage 2 구현 중 테스트로 흡수. **차단 게이트 아님.**

> Gate 1·2·3 결과는 이 문서 §7 에 날짜·출력과 함께 append 한다. 통과했다고 적을 때는
> 실제 출력을 붙인다.

---

## 3. Stage

### Stage 1 — port 0 기동 (Gate 1·2 통과 후) — **완료 2026-08-14**

**목표**: 신규 세션의 포트 충돌 클래스를 제거한다.

| 파일 | 변경 |
|---|---|
| `src/core/chrome-launcher.ts` | `allocate(opts.port)` → `--remote-debugging-port=0`. 기동 후 `profiles/<name>/DevToolsActivePort` 폴링(타임아웃 ~10s)해 실제 port/ws path 판독 |
| `src/core/session-store.ts` | `SessionMetadata.wsEndpoint` 를 **캐시 힌트**로 강등(주석 명시). `port` 는 관측값 기록 |
| `src/core/port-allocator.ts` | 신규 경로에서 미사용. `--port` 명시 시에만 레거시 경로로 유지 |
| `src/core/process-guard.ts` (`killAndWait`) | 종료 확인 후 `profiles/<name>/DevToolsActivePort` 삭제. SIGTERM·SIGKILL·graceful 어느 경로로도 Chrome 이 지우지 않는다 **[측정 §7.4a]** |

`--port <n>` 을 사용자가 명시하면 고정 포트로 뜨고 `DevToolsActivePort` 는 생기지
않는다 **[측정]**. 이 경우 앵커 대상이 될 수 없음을 CLI 가 경고해야 한다.

**검수 결과 (2026-08-14, 실행 출력):**

```
$ tirno new t-port0
✓ Session 't-port0' created (port 50747, PID 6000)
$ cat ~/.tirno/profiles/t-port0/DevToolsActivePort
50747
/devtools/browser/36e1f45e-e9ed-47ac-8100-06f056182cb1
meta: port=50747(관측값)  chromeFlags[0]="--remote-debugging-port=0"(선언값)

$ tirno nav https://example.com     → ✓ (200, 247ms)
$ tirno screenshot                  → ✓ 1920x1080
$ tirno ls                          → t-port0  50747  running
```

앵커 실증 — `~/.tirno/anchors/main -> ../profiles/t-port0` 심링크에 MCP 를 붙여:

```
list_pages → ## Pages
             1: Example Domain (https://example.com/) [selected]
```

즉 tirno 가 띄우고 tirno 가 이동시킨 페이지를 브라우저 MCP 가 **포트를 모른 채** 본다.

정리·재기동 경로:

```
$ tirno kill t-port0    → DevToolsActivePort 삭제됨 (No such file)
낡은 포트 19999 를 심어두고 재기동 → meta.port = 50977 (stale 무시 확인)
```

마지막 줄이 launch 직전 선삭제의 회귀 검사다. 선삭제가 없으면 `waitForActivePort` 가
이전 Chrome 의 포트를 즉시 읽어 조용히 틀린 값을 기록한다.

**범위 밖으로 확인만 하고 두는 기존 문제 두 가지** (이번 변경과 무관, main 에서도 재현):

- `tirno new` 는 작업을 마친 뒤에도 **프로세스가 종료되지 않는다**(`tirno ls` 는 즉시 종료).
  clean main 에서도 45s 후 살아있음을 확인. 별건.
- `--` 뒤 첫 chrome 플래그가 commander 의 positional `[url]` 로도 먹혀
  (`url: --no-proxy-server`) chrome 커맨드라인에 **중복 전달**된다. 별건.

### Stage 2 — inventory + ownership (독립 가치 있음) — **완료 2026-08-14**

**목표**: "지금 뭐가 살아있고 그게 내 것인가"에 사실로 답한다. 이 Stage 는 Gate 1
실패 시에도 그대로 필요하다.

신규 `src/core/inventory.ts`:

```
lsof -nP -iTCP -sTCP:LISTEN
  → 포트 목록
  → GET /json/version  (--max-time 필수)
  → 포트 점유 pid
  → ps 로 커맨드라인 파싱 (--user-data-dir 추출)
  → 분류
```

**분류 규칙 — 3중 일치일 때만 `ours`:**

1. pid 생존
2. 그 pid 가 그 포트를 LISTEN
3. 커맨드라인 `--user-data-dir` 이 `~/.tirno/profiles/` 하위

| 분류 | 조건 | 허용 조치 |
|---|---|---|
| `ours` | 3중 일치 | connect / kill / 프로필 관리 |
| `foreign` | 하나라도 불일치 | **표시만.** kill·purge 영구 금지 |
| `ambiguous` | 같은 포트에 리스너 2개 이상(IPv4/IPv6) | **표시만.** 자동 조치 전면 금지 |
| `ghost` | 대장에 있으나 리스너·pid 없음 | 대장 엔트리 정리 대상 |

`src/core/chrome-connector.ts` 의 `isAlive(meta.pid)` 단일 판정을 이 검사로 교체.
`foreign` 이면 **무엇에 붙으려 했는지 밝히며 거부**한다:

```
Refusing to connect to session "legacy-widget-session" (port 9222):
  owner = OtherAgentApp (pid 1285), user-data-dir outside ~/.tirno/profiles/
```

`tirno ls` 에 `owner` 컬럼 추가.

**검수 결과 (2026-08-14, 실행 출력):**

```
$ tirno ls
   │ NAME                   │ PORT │ STATUS │ OWNER                       │ ...
   │ admin-30s-fix-verify   │ 9225 │ dead   │ ghost
   │ legacy-widget-session │ 9222 │ dead   │ foreign(OtherAgentApp)
   │ sandweb                │ 9223 │ dead   │ ghost
   │ tmp-bc                 │ 9224 │ dead   │ ghost
```

예측대로다. 두 조치 경로 모두 실제로 막힌다:

```
$ tirno pages -s legacy-widget-session
✗ Refusing to connect to session 'legacy-widget-session' (port 9222):
  pid 68429 is gone; port 9222 now belongs to OtherAgentApp (pid 1285)

$ tirno kill legacy-widget-session
✗ Refusing to kill 'legacy-widget-session' — foreign: …
  → OtherApp(pid 1285) 생존 확인, 대장 엔트리도 보존
```

`ambiguous` 는 2026-07-07 사고 형태를 실제로 재현해 검증했다 — tirno 세션(IPv4)과
무관한 chrome(`--remote-debugging-address=::1`)을 같은 포트 9411 에 올린 뒤:

```
$ tirno ls   → t-amb … ambiguous
$ tirno pages -s t-amb
✗ … port 9411 has 2 listeners: Google Chrome(pid 54505, IPv4) + Google Chrome(pid 54529, IPv6)
$ tirno kill t-amb
✗ Refusing to kill … ambiguous: (동일)
  → 두 chrome 모두 생존
IPv6 쪽을 사람이 종료해 모호성 해소 → ours 로 바뀌고 kill 정상 동작
```

정상 세션 회귀도 확인: `ours` 표시, `pages`/`nav` 정상, `kill` 정상.

**계획과 다르게 간 곳 (사유):**

- 판정 3의 조건을 "`~/.tirno/profiles/` 하위"가 아니라 **"세션이 기록한
  `userDataDir` 과 일치"**로 구현했다. 전자는 `--ephemeral` 세션(프로필이
  `os.tmpdir()` 하위)을 전부 `foreign` 으로 만들어 기존 기능을 깨뜨린다. 후자가 더
  강한 조건이며 OtherApp 케이스도 동일하게 걸러낸다. `profiles/` 하위 검사는 삭제
  가드(Stage 4)에서 별도로 필요하다.
- `tirno kill` 에도 같은 판정을 걸었다. 플랜은 kill 가드를 Stage 4 에 뒀지만, 연결만
  막고 kill 을 열어두면 §1 원칙 3("`foreign` 은 건드리지 않는다. 예외 없음")이
  반쪽이 된다. 실제로 오살해가 일어나는 경로는 gc 가 아니라 `kill` 이다.

**남는 구멍 (Stage 4 로):** `foreign` 판정이 고정된 세션은 `tirno kill` 로 대장
엔트리를 지울 수 없다(kill 자체가 거부되므로). `tirno gc` 가 맡아야 한다.
→ **Stage 4 에서 해결됨** (`gc` 가 엔트리만 삭제, 프로세스·프로필은 불변).

### Stage 3 — anchor (Gate 3 통과 후) — **완료 2026-08-14**

신규 `src/commands/anchor.ts`:

| 명령 | 동작 |
|---|---|
| `tirno anchor ls` | 앵커 → 세션 매핑, 각 대상의 ownership/liveness |
| `tirno anchor set <anchor> <session>` | `~/.tirno/anchors/<anchor>` 심링크 교체 |
| `tirno anchor set ... --evict` | 교체 + **이전** Chrome 종료(연결 캐시 무효화) |
| `tirno anchor rm <anchor>` | 심링크만 제거 (프로필 불변) |

`anchors/*` 는 CLI 의 `active` 와 **별개**다. 섞지 않는다 — CLI 세션 전환이 MCP 대상을
바꾸면 사고다.

README 에 MCP 설정 예시를 싣는다(앵커 N개 = MCP 엔트리 N개로 worktree 병렬).

**검수 결과 (2026-08-14, 실행 출력):** 세션 a1/a2 를 띄우고 앵커 하나로 전환.

```
$ tirno anchor set mcp a1     → ✓ Anchor 'mcp' → ../profiles/a1 (session 'a1')
$ tirno anchor ls
 ANCHOR │ SESSION │ PORT  │ OWNER │ TARGET
 mcp    │ a1      │ 51294 │ ours  │ ../profiles/a1
MCP(--auto-connect --user-data-dir=…/anchors/mcp) → "SESSION-A1"
```

**설계 §4 의 "핫스왑은 안 된다" 한계를 그대로 실증** — MCP 프로세스 하나를 유지한 채:

```
call 1                        → SESSION-A1
anchor set mcp a2 (evict 없음) → call 2 → SESSION-A1  (연결 캐시 때문에 안 옮겨감)
anchor set mcp a2 --evict     → ✓ Evicted 'a1' (PID 66762)
                              → call 3 → "browser was restarted or reconnected" + SESSION-A2
```

`anchor rm mcp` → 심링크만 사라지고 `profiles/a2` 보존 확인.
경로 가드: `anchor set ../escape a2` → `Invalid anchor name '../escape'`.

**구현 중 드러난 것 두 가지:**

- `--evict` 는 **이 명령이 밀어낸** Chrome 만 안다. 앞선 실행에서 이미 앵커를 옮겨놨다면
  그 Chrome 은 더 이상 "previous" 가 아니라 evict 대상이 못 된다 → 그 경우
  `tirno kill <session>` 을 쓰라고 안내한다.
- `anchors/<name>` 이 심링크가 아니라 **실제 디렉토리**면 set·rm 모두 거부한다. 프로필
  데이터일 수 있고, 조용히 unlink 하면 로그인 세션이 날아간다.

**테스트 가능성을 위한 변경:** `session-store` 의 경로 상수를 지연 평가 함수로 바꾸고
`TIRNO_DIR` 환경변수 override 를 넣었다(`TIRNO_CACHE_DIR` 과 같은 방식). Stage 4 의 gc 는
프로필을 **삭제**하므로 실제 `~/.tirno` 에 대고 테스트할 수 없다.

### Stage 4 — gc (마지막, 옵트인) — **완료 2026-08-14**

`tirno gc [--dry-run] [--older-than <N>d]`

| 대상 | 기본 동작 |
|---|---|
| `ghost` 대장 엔트리 | 자동 삭제 |
| stale `DevToolsActivePort` (파일 있음, 리스너 없음) | 자동 삭제 |
| orphan 프로필 (대장에 없는 디렉토리) | **목록화만** |
| 오래된 프로필 | `--older-than` 명시 시에만. 기본 `--dry-run` 권장 |
| 앵커 대상 / `active` 세션 / 살아있는 세션 | **보존** |
| `foreign` / `ambiguous` | **불가** |

경로 가드: 삭제 대상은 `~/.tirno/profiles/` 하위 **단일 세그먼트**일 때만.
`..`·슬래시 포함 이름은 거부. 삭제 전 크기와 최종 사용 시각을 출력한다.

**구조**: `scan()`(관측) → `plan()`(**순수** — 규칙을 삭제 없이 검증 가능) → `apply()`(실행).
가드는 `plan()` 뿐 아니라 unlink **직전에 다시** 검사한다(`assertDeletable`) — 계획 시점에만
도는 삭제 가드는 리팩터 한 번이면 안 도는 가드가 된다. 심링크는 프로필 목록에서 아예 제외.

**검수 결과 (2026-08-14):** 실제 대장에는 `--dry-run` 만 돌리고, 삭제 경로는 샌드박스
`TIRNO_DIR` 에서 CLI 전 경로로 검증했다(사용자 세션을 지울 이유가 없다).

실제 머신 `gc --dry-run`:

```
→ keep 2026-05-10-admin-profile — orphan profile (no session entry). Use --older-than <N>d to remove.
  … (orphan 11개 목록화만)
→ would remove session-entry admin-30s-fix-verify — ghost — pid 82569 is gone and nothing listens on 9225
→ would remove session-entry legacy-widget-session — foreign — pid 68429 is gone; port 9222 now
  belongs to OtherAgentApp (pid 1285) (entry only; process and profile untouched)
→ Dry run — nothing changed. 5 item(s) would be removed.
```

샌드박스 3단계 (ghost 세션 + stale 포트파일 + orphan 3종 + profiles/ 안의 심링크):

| 단계 | 결과 |
|---|---|
| `gc --dry-run` | 6줄 보고, **디스크 무변경** 확인 |
| `gc` | ghost 엔트리 + stale 포트파일만 삭제. orphan 3개 전부 보존 |
| `gc --older-than 30` | `ancient`(200일) 만 삭제. `fresh`(2일)·`anchored-old`(앵커됨) 보존, 심링크 대상 `Cookies` 무사 |

**계획과 다르게 간 곳 (사유):** 표의 "`foreign` → 불가" 를 **프로세스·프로필에만** 적용하고
**대장 엔트리는 삭제**한다. tirno 자기 json 을 지우는 것은 남의 것을 건드리는 게 아니고,
`tirno kill` 이 foreign 을 거부하므로(설계대로) 그러지 않으면 **그 엔트리를 지울 수단이
아예 없다** — Stage 2 에서 적어둔 구멍이 이것이다. 프로필은 남으므로 같은 이름으로
`tirno new` 하면 로그인도 그대로 복구된다. `ambiguous` 는 엔트리조차 건드리지 않는다.

### Stage 5 — drift 경고 (선택, 후순위) — **완료 2026-08-14**

세션의 `chromeFlags`(선언) vs 실행 중 커맨드라인(실제) 비교 → 차이 경고.
`--host-resolver-rules` 는 launch-time 스냅샷이라 실행 중 변경 불가 → **재기동 제안**.
앵커 방식에서는 재기동 비용이 사실상 0(포트 경합 없음, 프로필 영속, MCP 자동 재연결).

`../wishs.md` 의 "wires.yaml 변경 시 세션 옵션 갱신" 요구가 여기에 대응한다.

**대응 관계를 정확히 적어둔다** (`wishs.md` 는 레포 루트에 있다 — `docs/` 기준 `../`):

- wish **A(우선순위 높음)** 는 sandweb 이 `wires.yaml` 의 host 목록에서 만든
  `--host-resolver-rules` 가 바뀌었을 때 **세션을 새 옵션으로 갱신**하는 수단을 원한 것이고,
  기대 형태로 `tirno restart sandweb -- <new-flags>` 를 직접 적어뒀다. 그 갱신 수단
  자체는 **이미 있다**(`restart`, `new --force`).
- 남아 있던 구멍은 **"갱신이 필요한지 판정"** 이다. sandweb 은 매번 재기동할지, 아니면
  바뀐 경우에만 할지 알 방법이 없었다. `tirno drift sandweb -- <wires.yaml 로 만든 flags>`
  가 그 판정을 준다 — 같으면 exit 0, 다르면 차이와 재기동 명령을 내고 exit 1.
  wish **D** 가 요청한 "bash `&&`/`||` 로 분기 가능한 exit code" 와 같은 형태다.

즉 Stage 5 는 wish A 를 대체하는 게 아니라 **A 를 조건부로 만들어 주는 판정**이다.

`tirno drift [name] [--all] [-- <기대 flags>]`

- 인자 없이 → 대장의 `chromeFlags`(선언) vs 실행 중 커맨드라인
- `--` 뒤에 flags → **그 flags** vs 실행 중. 이게 "라우팅 설정이 바뀌었는데 이 세션은
  재기동해야 하나?" 에 답하는 형태다. tirno 는 규칙의 의미를 모른 채 답할 수 있다
- drift 가 있으면 **exit 1** — 자동화에서 게이트로 쓸 수 있다

**extra flag 은 보고하지 않는다.** puppeteer·chrome 이 자기 기본 인자를 수십 개 붙이므로
"선언에 없는데 실행 중" 은 정상 상태다. 그걸 defect 로 올리면 의미 있는 두 신호(missing,
changed)가 묻힌다. 전체 커맨드라인이 필요하면 `--all`.

**검수 결과 (2026-08-14, 실행 출력):**

```
$ tirno new d1 -- --host-resolver-rules="MAP example.com 127.0.0.1"
$ tirno drift d1
✓ 'd1' matches its declared flags                                    (exit 0)

$ tirno drift d1 -- --host-resolver-rules="MAP example.com 10.0.0.1"
→ changed  --host-resolver-rules: expected MAP example.com 10.0.0.1,
                                  running  MAP example.com 127.0.0.1
✗ 'd1' has drifted. Chrome only reads these at launch — restart to apply:
→   tirno restart d1 -- --host-resolver-rules='MAP example.com 10.0.0.1'   (exit 1)

$ tirno restart d1 -- --host-resolver-rules='MAP example.com 10.0.0.1'
$ tirno drift d1 -- --host-resolver-rules="MAP example.com 10.0.0.1"
✓ 'd1' matches its expected flags                                    (exit 0)
```

제안 명령을 **그대로 붙여넣어 실행**했고 drift 가 해소되는 것까지 확인했다.

**구현 중 잡은 것:** 제안 명령의 값에 공백이 있으면(`--host-resolver-rules=MAP a.com 1.2.3.4`)
인용 없이는 붙여넣을 때 인자 3개로 쪼개진다 → `shellQuoteFlag`. 실제 `sh` 에 통과시켜
왕복 검증하는 테스트를 붙였다.

`inventory` 의 `parseUserDataDir` 은 새 `parseFlags` 위로 옮겼다 — 커맨드라인 파싱 규칙이
두 벌 있으면 한쪽만 고쳐지는 게 시간문제다. 기존 테스트 전부 그대로 통과.

---

## 4. 테스트

| ID | 대상 | 내용 |
|---|---|---|
| T1 | ownership 분류 | `lsof`/`ps`/`/json/version` 출력을 픽스처로 고정. **9222=OtherApp 사례를 실제 케이스로 포함** |
| T2 | ghost 판정 | 대장에는 있고 리스너 없는 세션 |
| T3 | `DevToolsActivePort` 회귀 | port 0 기동 시 파일 생성 + 파싱. **Chrome 업데이트로 깨질 수 있는 관측 동작이라 회귀 테스트 필수** |
| T4 | 경로 가드 | `..`, 절대경로, 슬래시 포함 이름의 프로필 삭제 거부 |
| T5 | 레거시 세션 | 고정 포트 + `wsEndpoint` 만 있는 세션이 여전히 connect 됨 |
| T6 | ambiguous | 같은 포트 IPv4/IPv6 이중 리스너 시 자동 조치 차단 |

---

## 5. 마이그레이션 — 기존 세션을 깨지 않는다

현재 `~/.tirno/profiles/*` 전수에 `DevToolsActivePort` 가 **하나도 없다** — 지금까지
전부 고정 포트로 띄웠기 때문이다 **[측정: 2026-08-14]**.

연결 판정 순서를 이렇게 둔다:

1. `profiles/<name>/DevToolsActivePort` 존재 → **그 값을 진실로** 사용 (신규 경로)
2. 없으면 메타의 `port`/`wsEndpoint` 로 폴백 (레거시 경로)
3. 어느 쪽이든 **§3 Stage 2 의 3중 일치 검사를 통과해야** 연결

즉 레거시 세션은 계속 붙되, **소유권 검사는 동일하게 받는다.** 9222/OtherApp 는
이 시점부터 차단된다.

일괄 재기동은 하지 않는다. 세션을 다음에 `tirno new` 로 다시 띄울 때 자연히 port 0
경로를 탄다.

---

## 6. 범위 밖 (하지 않는 것)

- **WS 릴레이 / 프록시** — 앵커 N개로 대체된다. 짓지 않는다.
- **상시 데몬** — stateless CLI 철학 유지. 자동 기동(auto-launch)도 넣지 않는다.
- **라우팅 규칙 해석** — `--host-resolver-rules` 등은 호출자가 주는 불투명 플래그다.
  tirno 는 의미를 모른다. 특정 라우팅 도구에 대한 의존을 만들지 않는다.
- **다른 도구의 대장 정리** — 남의 세션 파일은 읽지도 지우지도 않는다.
- **Firefox/WebKit** — `research-multi-browser.md` 의 별건.

---

## 7. Gate 결과 기록 (append-only)

> 통과/실패를 적을 때 **실제 출력**을 함께 붙인다. "될 것 같다"는 기록하지 않는다.

| Gate | 날짜 | 결과 | 근거 |
|---|---|---|---|
| 1 | 2026-08-14 | **통과** | 아래 §7.1 |
| 2 | 2026-08-14 | **통과** | 아래 §7.2 |
| 3 | 2026-08-14 | **통과** | 아래 §7.3 |
| 4 | 2026-08-14 | 관측 완료 | 아래 §7.4 — **설계 서술 하나가 반증됨** |
| 5 | — | 미실행 | Stage 2 구현 중 테스트로 흡수 |

검증 환경: Chrome 151.0.7922.109 · `chrome-devtools-mcp` **1.7.0**
(`~/.npm/_npx/15c61037b1978c83/...` — research 문서가 적은 1.6.0 은 그 사이 갱신됐다.
`browser.js` 의 `userDataDir` → `DevToolsActivePort` 분기와 `index.js` 의 `autoConnect`
분기는 1.7.0 에서도 동일함을 소스로 재확인).

검증 방법: MCP 서버 args 는 클라이언트 기동 시 고정이라 Claude Code 재시작이 필요하다.
대신 MCP 서버를 **stdio 로 직접 spawn 해 JSON-RPC**(`initialize` →
`notifications/initialized` → `tools/call`)를 보냈다. 같은 프로세스·같은 코드 경로다.

#### 7.1 Gate 1 — MCP 가 port-0 Chrome 에 붙는가 → **통과**

```
$ "…/Google Chrome" --remote-debugging-port=0 --user-data-dir=~/.tirno/probe-anchor about:blank &
$ cat ~/.tirno/probe-anchor/DevToolsActivePort
59524
/devtools/browser/fd7be2ef-7a84-411e-b7bd-27f299394ff4

$ lsof -nP -iTCP:59524 -sTCP:LISTEN
Google    52317 me   62u  IPv4 …  TCP 127.0.0.1:59524 (LISTEN)
```

MCP(`--auto-connect --user-data-dir=/Users/me/.tirno/probe-anchor`) → `list_pages`:

```
INIT serverInfo: {"name":"chrome_devtools","version":"1.7.0"}
## Pages
1: about:blank [selected]
```

**"정말 그 Chrome 인가"를 정황이 아니라 증거로** — 프로브 Chrome 에만 고유 마커 탭을
띄우고 다시 호출:

```
## Pages
1: about:blank [selected]
2: GATE1-MARKER-7df93a26 (data:text/html,<title>GATE1-MARKER-7df93a26</title>)
```

→ MCP 가 반환한 것은 그 프로필의 Chrome 이다. **§4 설계 성립. §7 fallback 불필요.**

#### 7.2 Gate 2 — 재기동 추적 → **통과**

MCP 프로세스 하나를 유지한 채 Chrome 만 PID 로 종료 후 재기동:

```
[A] chrome pid=56847 port=60057
[call 1] ## Pages
         1: GATE2-CHROME-A [selected]

>>> kill -TERM 56847   (MCP pid 56846 는 그대로 살아있음)
[B] chrome pid=56907 port=60077   (portA=60057 → portB=60077, changed=true)

[call 2 — SAME MCP process]
Note: the browser was restarted or reconnected since the last call.
      Page ids have changed. Call list_pages to see open pages.
## Pages
2: GATE2-CHROME-B [selected]
```

포트가 바뀌었는데 **MCP 재시작 없이** 새 Chrome 을 잡았다. research §3.1 이 소스로만
확인했던 `reconnected` 경로(`browser.js:35`)가 사용자 눈에 보이는 노트로 실증됐다.

#### 7.3 Gate 3 — 심링크 투과 → **통과**

설계 §4 형태 그대로, **상대경로** 심링크:

```
~/.tirno/anchors/main -> ../profiles/probe-gate3
```

MCP 는 `--user-data-dir=~/.tirno/anchors/main`, Chrome 은
`--user-data-dir=~/.tirno/profiles/probe-gate3`. Gate 1·2 를 동일 시나리오로 재실행:

```
[A] chrome pid=58121 port=60250 → [call 1] GATE2-CHROME-A
[B] chrome pid=58192 port=60267 → [call 2] GATE2-CHROME-B  (재시작 없이 추적)
```

→ **Stage 3 의 심링크 방식 그대로 진행 가능.**

#### 7.4 Gate 4 — 종료 잔존물 (관측) → 설계 서술 하나 반증

**(a) 모든 종료 경로에서 `DevToolsActivePort` 가 남는다.**

| 종료 방법 | 종료 +3s 후 파일 |
|---|---|
| `SIGTERM` | **남음** — `"60443\n/devtools/browser/91b04d1b-…"` |
| `SIGKILL` | **남음** — `"60469\n/devtools/browser/2b9c717f-…"` |
| CDP `Browser.close` (graceful) | **남음** — `"60676\n/devtools/browser/10760c56-…"` |

research §4 의 "Chrome 은 정상 종료 시 지우지만 크래시하면 남는다" 는 **이 머신·이
버전에서 반증됐다.** graceful 경로까지 남는다. tirno 의 `killAndWait`(SIGTERM→SIGKILL,
`process-guard.ts:19-31`)은 위 첫 두 줄에 정확히 해당하므로 — **tirno 로 세션을 죽이면
항상 stale 파일이 남는다.**

**(b) 에러 메시지는 두 가지로 구분된다** (진단·GC 판정에 쓸 수 있다):

```
파일 있음 + 리스너 없음 →  Could not connect to Chrome. …
                          Cause: connect ECONNREFUSED 127.0.0.1:60443
파일 없음               →  Could not connect to Chrome in <dir>. …
                          Cause: ENOENT: … open '<dir>/DevToolsActivePort'
```

**(c) stale 파일로 오접속은 일어나지 않는다 — 9222/OtherApp 의 port-0 판은 불가능하다.**

죽은 세션의 stale 파일을 남긴 채, **무관한 프로필의 Chrome 이 그 포트를 그대로 점유**하게
만들고 앵커로 MCP 를 호출했다:

```
ours(죽음)  stale ws: ws://127.0.0.1:60937/devtools/browser/87bca93b-b97d-4076-95e5-2e0c77799e1f
squatter    실제 ws: ws://127.0.0.1:60937/devtools/browser/9e4eccb1-0719-4276-b5de-ae1ace0356f3

MCP → isError=true :: Could not connect to Chrome. …
      Cause: Unexpected server response: 404
```

`DevToolsActivePort` 의 browser UUID 가 **인스턴스 식별자 역할**을 해서, 포트가 재사용돼도
남의 브라우저에는 붙지 못한다. 고정 포트 + `--browser-url` 방식에는 이 방어막이 없다
(포트 번호만 맞으면 붙는다 — 그게 9222 사고였다).

**→ Stage 4 에 대한 함의:** stale `DevToolsActivePort` 삭제는 **안전 요건이 아니라
위생·진단 문제**다(오접속은 UUID 가 막는다). 다만 남겨두면 사용자가 보는 에러가
`ECONNREFUSED <포트>` 라 원인 파악이 어려우므로 자동 삭제 대상으로 두는 판단은 유지한다.
추가로 **`kill` 경로에서 종료 직후 직접 지우는 것**이 GC 를 기다리는 것보다 낫다.

이 오접속 불가 성질은 **ownership 3중 일치 검사를 대체하지 않는다.** UUID 가 막는 것은
"MCP 가 앵커를 통해 남의 브라우저에 붙는 것"뿐이고, tirno 자신이 메타의
`port`/`wsEndpoint` 로 붙는 레거시 경로(§5)에는 그 방어막이 없다.

### 사전 측정 (2026-08-14, 설계 근거)

```
--remote-debugging-port=0    → DevToolsActivePort 있음
                               "61883\n/devtools/browser/7df93a26-3262-48ee-85eb-8ac4d725da03"
--remote-debugging-port=9411 → DevToolsActivePort 없음
~/.tirno/profiles/* 전수     → DevToolsActivePort 없음 (전부 고정 포트로 기동돼 옴)
```

### 인벤토리 스냅샷 (2026-08-10, ownership 설계 근거)

```
9222  OtherAgentApp pid 1285   ← 대장은 "legacy-widget-session pid 68429(죽음)"
9225  리스너 없음 / pid 82569 없음    ← 대장은 살아있는 세션
```

---

## 8. 다음 행동

Gate 1·2·3 통과(§7). **Stage 1 착수 가능.**

Gate 4 가 플랜에 남긴 변경 두 가지:

1. Stage 1 의 `kill` 경로에서 **종료 직후 `DevToolsActivePort` 를 지운다**
   (모든 종료 경로에서 남는 것이 실측됐다 — §7.4a).
2. Stage 4 의 stale 파일 삭제는 안전 요건이 아니라 위생·진단 항목으로 격하.
   자동 삭제 유지, 우선순위만 낮다.
