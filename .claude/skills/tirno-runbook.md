---
description: tirno 로 실제 브라우저 작업을 끝까지 수행하는 절차. 세션 기동 → 대상 파악(snapshot @ref) → 조작 → **결과 검증** → 정리, 그리고 막혔을 때의 진단 순서. 명령 레퍼런스가 아니라 "어떻게 일하는가" — 레퍼런스는 /tirno, mcp 매핑은 /tirno-mcp.
---

# tirno 작업 런북

한 줄: **조작했다고 됐다고 하지 않는다. 페이지에서 결과를 다시 읽어 확인한 뒤에 됐다고 한다.**

`--help` 도, 이 문서도 선언이다. 신뢰 대상은 방금 그 브라우저가 보여준 값이다.

무엇이 있는지는 **`tirno schema`** 에 물어라. `--help` 은 사람용 산문이라 서브커맨드
26개가 최상위에 안 보이고, 긁으면 없는 플래그가 나온다. `schema` 는 commander 트리에서
자동 생성이라 CLI 와 어긋나지 않는다.

```bash
tirno schema --pretty | jq '.commands[] | select(.destructive) | .name'
```

**되돌릴 수 없는 명령을 실행 전에 가려내는 유일한 기계적 방법이다** — 지금은 8개다
(`kill` `gc` `restart` `close-tab` `cache prune` `trail rm` `record rm` `auth rm`).

## 0. 가치 흐름 (CLAUDE.md, 불변)

위에서부터 시도하고, 마지막은 자존심 굽혀 부탁한다.

1. **cache lookup** — `tirno cache load <url>` (결정론, ms)
2. **multi-channel fallback** — selector → a11y(`@ref`) → bbox → ocr (결정론, ms)
3. **CDP 직접 분석 + 자율 시도** — `snapshot` / `eval` / `cdp` 로 구조를 뜯어본다
4. **사용자 시연 부탁** — `tirno trail capture` / `record start`. **마지막 보루**

**tirno 안에 LLM 은 없다.** 지능이 필요한 판단은 이 도구를 부르는 쪽이 한다.

1·2번을 건너뛰고 바로 3번으로 가는 것은 이 도구를 쓰는 이유를 버리는 것이다.

## 1. 세션 기동

```bash
tirno new <name> <url> --headless --ephemeral    # 일회성 작업
tirno new <name> <url>                           # 로그인이 남아야 하면 프로필 유지(=--ephemeral 없이)
```

- `tirno new` 는 **즉시 반환하고 chrome 은 계속 산다.** 백그라운드로 돌리거나 기다릴 필요 없다.
- chrome 플래그는 `--` 뒤에. **URL 은 `--` 앞**에 둔다 — 뒤에 두면 chrome 몫이 된다.
  ```bash
  tirno new work https://example.com -- --no-proxy-server --host-resolver-rules="MAP *.x.dev 127.0.0.1"
  ```
- 포트는 OS 가 준다. `--port` 는 레거시이고 그 세션은 MCP 앵커 대상이 못 된다.
- 브라우저 MCP 를 같이 쓸 거면 `tirno anchor set <anchor> <name>` — 자세한 건 `/tirno`.

## 1.5 준비 대기 — `readyState` 를 믿지 말 것

`tirno new` 는 chrome 이 살아나면 반환한다. 페이지가 쓸 수 있는 상태라는 뜻이 아니다.
바로 뒤에 `document.readyState` 를 물으면 `complete` 가 나오는데도 노리던 요소는 없을 수 있다
(실측: HN 첫 화면에서 `readyState=complete` · `input[name="q"]` 는 0개).

**요소 유무로 기다린다.**

```bash
tirno wait-for '<selector>' --timeout 10000
tirno wait-for --text "<보일 문구>" --timeout 10000
tirno wait-for --network-idle
```

`snapshot` 을 뜨는 경로는 이게 덜 드러난다 — 트리를 뜨는 동안 시간이 지나기 때문이다.
**캐시 경로(아래)는 그 완충이 없으니 대기를 반드시 명시한다.**

## 2. 대상 파악 — 캐시부터, 그다음에 뜬다

### 2a. 캐시 (가치 흐름 1번)

이 URL 을 전에 본 적 있으면 브라우저를 분석할 이유가 없다.

```bash
tirno cache list                                  # 뭐가 쌓였나
tirno cache load <url> --json                     # ref + selector + bbox
```

**`--json` 을 쓴다.** 사람용 출력은 selector 를 대괄호로 감싸는데 selector 자체에 대괄호가
흔해서(`input[name="q"]`) 되읽을 수 없다.

```bash
tirno cache load https://example.com --json \
  | node -e "…refs.find(r => r.channels.a11y?.role === 'textbox')?.channels.dom.selector…"
```

실측 비교: `cache load` 89ms vs `snapshot` 422ms. 이 차이를 벌자고 만든 캐시다.
캐시에 없거나 페이지가 바뀌었으면 그때 2b 로 간다.

### 2b. 직접 뜬다 — 추측하지 말고

```bash
tirno snapshot            # a11y 트리 + @N ref 부여
tirno screenshot --out /tmp/s.png
```

- `@N` 은 **그 snapshot 직후에만** 유효하다. 페이지가 바뀌면 다시 뜬다.
- selector 를 확신하면 selector 가 빠르다. 확신이 없으면 `snapshot` 을 뜨고 `@N` 을 쓴다.
- 구조가 안 보이면 `tirno eval "document.querySelectorAll('form').length"` 처럼 직접 캐묻는다.

## 3. 조작

```bash
tirno click <selector|@N|"x,y">      # 좌표도 trusted click
tirno fill <target> <value>
tirno fill --batch '[{"target":"#id","value":"v"},{"target":"@7","value":"w"}]'
tirno type "<text>"   /   tirno press Enter
tirno hover <selector>   /   tirno drag <from> <to>   /   tirno scroll down
tirno upload <selector> <file...>
```

- `click`·`fill`·`hover`·`drag` 는 **대상 탭을 앞으로 가져온다.** 마우스 기반이라 그래야 동작한다.
  사용자가 보던 탭이 바뀔 수 있다는 뜻이다. `eval`·`screenshot`·`snapshot`·`type`·`scroll`·
  `upload` 는 CDP 직행이라 배경 탭에서도 되고 탭을 건드리지 않는다.
- 없는 요소는 즉시 `✗ No element found for selector: …` 로 끝난다(매달리지 않는다).

## 4. 검증 — 이 단계를 건너뛰면 작업을 안 한 것이다

```bash
tirno wait-for <selector> --timeout 5000
tirno wait-for --text "저장되었습니다" --timeout 5000
tirno wait-for --network-idle
tirno eval "document.querySelector('#status').textContent"
```

"클릭했다"는 증거가 아니다. **바뀌었어야 할 값을 다시 읽는다.** 스크린샷 한 장도 좋지만,
텍스트로 확인할 수 있으면 `eval` 이 낫다 — 사람이 눈으로 볼 필요가 없다.

## 4.5 멈췄을 때 — 렌더러 밖에서 잰다

페이지가 멈추면 DevTools 도 같이 멈춘다. DevTools 프론트엔드가 관측 대상과 **같은 큐에 줄을
서기** 때문이다. 그래서 "느리다"를 눈으로 확인하려는 순간 관측 수단을 잃는다.

```bash
tirno stall --window 10          # 10초 동안 밖에서 관측
tirno stall --window 10 --json
```

세 가지를 동시에 본다.

| 층 | 무엇 | 잡는 것 |
|---|---|---|
| ① renderer 왕복 | `Runtime.evaluate` 왕복시간 | **큐 대기시간.** 이 요청도 같은 줄에 서므로 앞에 밀린 양이 곧 지연 |
| ② task/script/layout/style % | `Performance` 카운터 델타 | **범인 지목.** JS 인가 레이아웃인가 |
| ③ browser 왕복 | 브라우저 타깃(별도 소켓) | **렌더러 탓이라는 증명.** 브라우저는 답하는데 렌더러만 안 답하면 확정 |

### 읽는 법

| task% | renderer 왕복 | 뜻 |
|---|---|---|
| < 50% | 1~5ms | 정상 |
| 50~90% | 정상 | 무거움. 저사양에서 체감 시작 |
| **100%** | 정상~수십ms | **짧은 태스크 폭주** — 입력은 받지만 CPU 포화(발열) |
| **100%** | **수백ms~무응답** | **큐 적체** — UI 정지, DevTools 안 열림 |
| 어느 쪽이든 | 렌더러만 느리고 browser 는 정상 | 렌더러 확정. browser 도 느리면 머신/GPU 쪽 |

**①과 ②는 서로 다른 장애를 잡는다. 하나만 보면 오판한다.** 짧은 태스크가 촘촘히 도는 유형은
CPU 가 100% 인데도 CDP 메시지가 태스크 *사이로* 끼어들어 왕복지연이 정상으로 나온다 — ①만 보면
"멀쩡하다"고 결론낸다. 실측(6k 요소, 병리 코드 ON): `task 98.2% · script 34.7%` 인데 왕복지연은
9ms 였다.

②의 내역으로 범인을 가른다 — `script` 우세는 JS 로직, `layout`/`style` 우세는 레이아웃 스래싱
(`getComputedStyle`/`getBoundingClientRect` 루프의 서명)이다. 둘 다 아닌데 `task` 만 높으면
GC·래스터·파싱이고, 이 카운터로는 더 못 쪼갠다.

### 언제 부르나

- **브라우저를 건드리는 명령이 30초 넘게 안 끝날 때.** 코드를 읽기 전에 먼저 잰다 —
  "내 코드가 안 끝나는 조건을 기다린다"와 "페이지가 메인스레드를 태워 요청이 큐에 밀린다"는
  증상이 같고, ③의 비대칭이 그 둘을 가르는 유일한 값이다
- 사용자가 "느리다/멈춘다/발열"을 말하는데 **DevTools 로 재현이 안 될 때**
- "이 코드가 성능 문제냐"를 **읽어서 답하려 할 때** (아래)
- 로딩이 안 끝날 때 — 단 `tirno network` 로 **미완료 요청부터** 본다.
  "로딩이 안 끝난다" ≠ "메인스레드가 잡혔다"

### 코드를 읽어서 결론내지 말 것

**코드에 있다 ≠ 실행된다.** 병리로 지목한 코드가 `if (window.innerWidth > 767) return;` 가드
하나 때문에 데스크톱 폭에서는 한 줄도 안 돌 수 있다 — 실제로 이 함정에 걸려 "재현 안 된다"는
결론이 나올 뻔했다. 뷰포트를 맞추기 전까지 `script` 는 0.2% 였고, `tirno emulate --viewport
390x844` 를 걸자 34.7% 가 됐다.

그래서 **단일 변수 A/B 로 잰다** — 의심 코드만 켜고 끄고, 나머지는 고정한다. 대조군의
`script 0.2%` 가 기준선이고 거기서 벌어지는 폭이 증거다. 조건(뷰포트·이벤트·상태)을 쓸 수 없는
지적은 내지 않는다.

## 5. 정리

```bash
tirno kill <name> --clean     # --ephemeral 이었으면 프로필까지
tirno ls                      # 남은 게 없는지
```

`--clean` 은 **프로필 디렉토리를 지운다 = 로그인 세션이 사라진다.** 다시 쓸 세션이면 붙이지 않는다.

## 막혔을 때 — 진단 순서

| 증상 | 먼저 볼 것 |
|---|---|
| 붙지를 못한다 | `tirno ls` 의 `OWNER`. `foreign`/`ambiguous` 면 그 포트는 내 것이 아니다 — 죽이려 들지 말 것 |
| 어제 되던 게 안 된다 | `tirno drift <name>` — 선언한 플래그와 실행 중 프로세스가 다른가. 다르면 `tirno restart` (재기동은 싸다: 포트는 OS 가 새로 주고 프로필은 남는다) |
| 요소를 못 찾는다 | 먼저 `wait-for <selector>` — `readyState=complete` 여도 아직 없을 수 있다. 그다음 `snapshot` 을 다시 뜬다(`@ref` 는 stale 이 된다) |
| **명령이 안 끝난다(30s+)** | `tirno stall --window 10` — 렌더러만 느리고 browser 가 정상이면 페이지 탓, 둘 다 정상이면 내 코드 탓이다 |
| 클릭이 먹지 않는다 | `tirno eval` 로 해당 요소가 실제로 있는지·가려져 있지 않은지 확인. 그다음 `click "x,y"` 좌표로 우회 |
| 스크린샷 크기가 다르다 | `emulate --reset` 은 tirno 기본값(1920x1080)으로 되돌린다. 브라우저 원상태가 아니다 |
| `back` 이 실패한다 | 같은 URL 로 `nav` 하면 히스토리가 안 늘어난다. 돌아갈 데가 없는 게 맞다 |
| 탭을 잘못 닫았다 | `tirno pages` 의 ID 는 위치가 아니라 **안정 핸들**이다(4자 이상 접두사 가능). 그 ID 를 쓴다 |

## 사실로 확인해 둔 제약

- `tirno audit` 은 lighthouse 를 부르므로 **http(s) 만** 된다. `file://` 은 `INVALID_URL`.
- `audit --mode timespan` 은 미구현이다.
- 단일 element 만 조회하는 명령(`tirno inspect` 같은 것)은 **없다.** `snapshot` 으로 트리를 뜨거나
  캐시된 페이지면 `cache load <url>` 이 ref + selector + bbox 를 준다.
- `tirno nav` 는 실패하면 **exit 1** 이다. `&&` / `||` 로 분기해도 된다. 단, 파이프 뒤에서
  종료코드를 읽으면 파이프 마지막 명령의 것을 읽는다 — `nav ... > /dev/null; echo $?` 로 재라.
- **`--group` 없는 `tirno broadcast` 는 모든 세션에 간다.** 남의 세션이 떠 있는 머신에서는
  항상 `--group` 을 붙일 것.
- `tirno ls --flags` 는 **80자에서 자른다.** 플래그 원문이 필요하면 `tirno export <name>`.
- `tirno drift` 가 `unreadable` 로 보고하는 플래그가 있다. 값에 `" --"` 가 들어가면
  실행 중 커맨드라인(`ps` 출력)에서 되읽을 수 없어서다 — 예: `--user-agent="tirno --probe"`.
  **이건 drift 가 아니다.** 재기동해도 같은 판정이 나오므로 고치려 들지 말 것.
- `tirno --help` 을 긁어 명령 목록을 만들지 마라. 여러 줄 설명이 명령 목록과 섞여
  **없는 플래그가 나온다**(실제로 `network show`·`auth get` 을 그렇게 만들어낸 적이 있다).
  기계로 읽을 때는 `tirno schema` 를 쓴다.
- `snapshot` 출력에서 조작 대상을 `grep textbox|button` 으로 찾으면 **`InlineTextBox` 가 대량으로
  걸려 정작 `searchbox`·`button` 이 묻힌다.** `@ref` 가 붙은 줄만 걸러라 — `grep -E '^@[0-9]+'`.

## 작업을 마치며

- 성공했으면 그 경로가 캐시·trail 에 남는지 확인한다(`tirno cache list`, `tirno trail list`).
  다음 세션이 1번 단계에서 바로 꺼내 쓰는 것이 이 도구의 존재 이유다.
- 실패했으면 **어디까지 갔고 무엇을 봤는지**를 남긴다. "안 됩니다"만 남기면 다음 세션이 같은
  삽질을 처음부터 반복한다.
