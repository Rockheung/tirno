# 명령 reference

정본은 `tirno schema` 다 — commander 트리에서 실행 시점에 뽑으므로 이 문서보다 늦지 않는다.
여기 표는 사람이 훑어보라고 있는 것이고, 기계가 읽을 것은 schema 다.

## 명령 reference

### 세션
| 명령 | 설명 |
|---|---|
| `new <name> [-- <chrome-flags>]` | 새 Chrome 세션 생성. `--`로 임의 flag 전달 (`--proxy-server`, `--host-resolver-rules` 등). 포트는 OS가 할당(`--port`로 고정 가능하나 그러면 MCP 앵커 대상이 못 됨) |
| `ls` | 세션 목록 (port, status, **owner**, proxy, emulation, last access) |
| `attach <name>` | active 세션 변경 |
| `kill [name]` | 세션 종료. `foreign`/`ambiguous`면 거부 |
| `new`/`restart` `--extensions` | 확장이 돌게 한다. **기본은 꺼짐** — 확장은 페이지가 하는 일을 바꾸고, 이 도구는 페이지를 있는 그대로 관측하려고 있다 |
| `restart <name> [url] [--keep-cookies] [-- <flags>]` | 죽이고 새 flag 로 재생성. **`--keep-cookies` 는 세션 쿠키까지 넘겨 로그인이 살아남는다** — `Expires` 없는 쿠키는 브라우저 종료와 함께 사라지므로, 이걸 안 주면 프로필은 남아도 로그인은 안 남는다 |
| `gc [--dry-run] [--older-than <N>]` | 낡은 장부 정리. 기본은 장부만(ghost/foreign 엔트리, 잔존 `DevToolsActivePort`). `--older-than <N>`일 때만 **N일 이상 안 쓴 orphan 프로필 삭제** |
| `drift [name] [--all] [-- <flags>]` | 선언한 chrome flag 와 실행 중 프로세스 비교. 차이 있으면 재기동 명령 제안 + **exit 1** |
| `rename <old> <new>` | 이름 변경 |
| `export <name>` | 메타데이터 출력 |

#### 어느 Chrome 을 쓰나

| 명령 | 설명 |
|---|---|
| `chrome` | 고를 바이너리와 **후보 전체를 순서대로** 출력. 못 찾으면 exit 1 |
| `chrome set <path>` | 그 경로를 `~/.tirno/config.json` 에 적어둔다 — 이후 세션은 `--executable-path` 가 필요 없다 |
| `chrome rm` | 적어둔 것을 지운다 |

순서는 **구체적인 것이 이긴다**:

```
--executable-path  →  $TIRNO_CHROME  →  $CHROME_PATH  →  $PUPPETEER_EXECUTABLE_PATH
                   →  ~/.tirno/config.json  →  고정 경로 탐색
```

명시적으로 가리킨 경로(플래그·env·설정)가 틀렸으면 **다음 후보로 넘어가지 않고 실패한다.**
조용히 다른 chrome 으로 넘어가면, 지정한 바이너리가 돌고 있다고 믿은 채 다른 것을 관측하게 된다.

탐색 목록(linux)에는 배포판 `chromium`, snap, 그리고 playwright·puppeteer 캐시가 들어 있다:

```
/usr/bin/google-chrome · google-chrome-stable · chromium · chromium-browser
/snap/bin/chromium · /usr/lib/chromium/chromium
~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome
~/.cache/puppeteer/chrome/*/chrome-linux*/chrome
```

**linux-arm64 에는 Google Chrome 이 아예 없다** — 구글은 리눅스용을 amd64 로만 배포한다.
릴리즈에 `tirno-bun-linux-arm64` 가 있으므로 이쪽이 실사용 경로다:

```bash
npx playwright install chromium     # arm64 빌드를 받는다
tirno chrome                        # 캐시 경로가 ok 로 잡히는지 확인
```

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

#### 번역 제안은 꺼진 채로 시작한다

세션을 만들 때 프로필의 `Default/Preferences` 에 `translate.enabled = false` 를 심는다.

`--disable-features=Translate` 로는 부족하다 — puppeteer 가 이미 그것을 넣고 있는데도 번역
UI 가 떴고, 프로필에 `translate_ignored_count_for_language` 가 남아 있었다(실측). 번역 버블은
페이지 위에 겹쳐 뜨고 레이아웃을 밀어내므로, 좌표로 클릭하고 스크린샷을 비교하는 도구에서는
관측 대상이 아니라 잡음이다 — 뷰포트를 1920x1080 으로 고정하는 것과 같은 이유다.

**이미 값이 있으면 건드리지 않는다.** 그 프로필에서 켰다면 그쪽이 나중 의사다.
#### 확장 — `--extensions` 없이는 방법이 없다

puppeteer 가 `--disable-extensions` 를 기본으로 넣고, **그것은 뒤에서 되돌릴 수 없다.**
`--load-extension` 을 뒤에 붙여도 상쇄되지 않고, `Extensions.loadUnpacked` 는 확장 id 를
돌려주면서 실제로는 아무것도 활성화하지 않는다 — 확장 타깃이 안 생기고 content script 도
안 돈다. **성공한 것처럼 보이는 응답이 돌아오는 것**이 이 실패의 고약한 점이라, 기동 때
빼는 것 말고는 길이 없다.

`--load-extension` 자체도 Chrome 151 에서 죽었다(tirno 를 안 거친 크롬에서도 안 먹는다).
그래서 로드는 CDP 로 한다:

```bash
tirno new dev --extensions
tirno cdp --browser Extensions.loadUnpacked '{"path":"/abs/path/to/ext"}'
tirno reload                      # content script 는 다음 문서부터 붙는다
```

**재기동하면 사라진다.** `loadUnpacked` 로 얹은 확장은 프로필에 남지 않아, `restart` 뒤에는
`--extensions` 를 다시 줘도 확장 타깃이 0 이다 — 로드를 다시 해야 한다(id 는 같다).

확장 페이지도 평범한 페이지처럼 다룬다:

```bash
tirno nav chrome-extension://<id>/popup.html
tirno eval "chrome.runtime.getManifest().name"
```

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
| `reload [--hard]` / `back` / `forward` | 페이지 이력 제어. `--hard` 는 캐시를 우회해 다시 받는다 |
| `pages` / `select <id>` / `new-tab [url]` / `close-tab <id>` | 탭 제어. ID 는 CDP targetId 앞 8자리로, 탭이 열리고 닫혀도 안 바뀐다(위치 인덱스가 아니다). 4자 이상이면 접두사로도 된다 |

### 검사
| 명령 | 설명 |
|---|---|
| `screenshot [--full] [--out path]` | 스크린샷 |
| `snapshot [--no-cache]` | a11y 트리 + visual cache 적재 |
| `console [--type <t>]` | 콘솔 메시지 (한정적 — stateless 모델 한계) |
| `network [--type <t>]` | reload 하고 networkidle2 에 이를 때까지의 요청 캡처 |

### 입력
| 명령 | 설명 |
|---|---|
| `click <selector\|@N>` | 클릭 |
| `fill <selector\|@N> <value>` | input clear + type |
| `fill <selector\|@N> --value-stdin` | 값을 stdin 에서 읽는다. **인자로 준 값은 `ps` 와 셸 히스토리에 남으므로**, 비밀번호는 `pbpaste \| tirno fill 'input[type=password]' --value-stdin` 으로 넣는다. 끝 개행 하나는 뗀다(`echo` 대비). 성공 메시지에 값을 찍지 않는다 |
| `type <text>` / `press <key>` / `hover <selector\|@N>` | 키보드/마우스 |
| `press <modifier>+<key>` | `Meta+v` · `Ctrl+a` · `Shift+Tab`. 수식키는 Alt·Ctrl·Meta·Shift(별칭 cmd/command/option 도 받는다) |
| `scroll up\|down\|<pixels>` | 스크롤 |
| `wait <ms>` / `wait-for [selector] [--text <s>] [--network-idle]` | 대기. 셋은 **대안이지 병용이 아니다** — 둘 이상 주면 거부한다 |
| `drag <from> <to>` | 드래그. 좌표(`"x,y"`)와 selector 를 자동 판별. `--steps` 로 중간 이동 수, `--hold` 로 누른 채 대기, `--native` 로 OS 레벨 드래그 이벤트 |
| `upload <selector> <files...>` | 파일 업로드 |

붙여넣기·복사·잘라내기·전체선택·실행취소는 **키 이벤트만으로 일어나지 않는다.** 브라우저가
그 동작을 실제로 하려면 CDP 에 `commands` 를 함께 실어야 하고(실측: `commands` 없이 Meta+V 를
보내면 포커스된 필드의 값이 그대로였다), `press` 가 그것을 채운다. `Meta` 든 `Ctrl` 이든 같은
명령으로 보낸다 — `commands` 는 브라우저에 동작을 직접 지시하는 것이라 플랫폼 관례와 무관하다.

| 조합 | 실리는 command |
|---|---|
| `Meta+v` · `Ctrl+v` | `paste` |
| `Meta+c` · `Meta+x` | `copy` · `cut` |
| `Meta+a` | `selectAll` |
| `Meta+z` · `Meta+Shift+z` · `Ctrl+y` | `undo` · `redo` · `redo` |

그 밖의 조합(`Shift+Tab`, `Meta+ArrowLeft` …)은 수식키를 누른 채 키를 눌렀다 떼는 평범한
입력으로 나간다.

**클립보드를 읽을 때는 `press 'Meta+v'` 가 `navigator.clipboard.readText()` 보다 싸다** —
후자는 권한과 문서 포커스를 둘 다 요구하고, 없으면 settle 하지 않는 promise 로 매달린다.

### 실행 / emulation
| 명령 | 설명 |
|---|---|
| `eval <expression> [--timeout <ms>]` | 페이지에서 JS 실행. **함수 리터럴은 호출한다**(아래). 기본 30초 — 페이지가 settle 하지 않는 promise 를 돌려주면 거기서 끊고 그렇게 말한다(`--timeout 0` 이면 CDP 연결이 허용하는 만큼, 약 3분). 페이지 쪽 실행을 멈추지는 않는다 |
| `cdp <method> [params]` | **원시 CDP 호출.** `params` 는 JSON. `--browser` 면 페이지가 아닌 브라우저 타깃에, `--listen <event> [--listen-ms <n>]` 이면 호출 후 이벤트를 받아 출력. tirno 가 감싸지 않은 도메인은 전부 이 문으로 들어간다 |
| `emulate [--device <name>] [--dpr <n>] [--network <p>] [--cpu <n>] [--reset]` | 영속 emulation |

`eval` 은 평가 결과가 **인자 없는 함수면 호출하고 그 반환을 낸다.** 안 부르면 함수 객체가
값이 되어 `{}` 로 직렬화되는데, 그것은 "함수를 안 불렀다" 가 아니라 "빈 결과" 로 읽힌다 —
여러 문장이 필요한 조작은 자연스럽게 함수로 감싸게 되므로 흔히 밟는 자리다.

```bash
tirno eval '() => { const a = 1, b = 2; return { sum: a + b }; }'   # → {"sum": 3}
```

인자를 받는 함수는 **부르지 않고 그렇게 말한다**(exit 1) — 무엇을 넘길지는 부르는 쪽만 알고,
undefined 를 밀어 넣으면 그쪽이 더 조용한 오답이 된다. 호출 결과가 또 함수일 때도 같다.

### 권한
| 명령 | 설명 |
|---|---|
| `permissions grant <origin> <permission...>` | origin 에 권한을 주고 세션에 기록. origin 은 `new URL(x).origin` 으로 정규화되므로 경로·쿼리를 붙여도 된다 |
| `permissions revoke [origin]` | 한 origin, 또는 인자 없으면 전부 해제 |
| `permissions ls [--json]` | 이 세션에 기록된 grant 목록 |
| `headers set <name> <value>` | 모든 요청에 붙일 고정 헤더. 세션에 기록되고 connect 마다 재적용된다 |
| `headers rm [name]` | 헤더 하나, 인자 없으면 전부 |
| `headers ls [--json]` | 이 세션의 고정 헤더 |

`perm` 으로 줄여 쓸 수 있다.

`headers` 는 `Network.setExtraHTTPHeaders` 라 **전역**이다 — 특정 호스트만 필터하려면 Fetch
인터셉트(상주 연결)가 필요해 지금은 지원하지 않는다. 헤더도 CDP 연결 수명에 묶여, permissions
와 같은 자리에서 connect 마다 재적용된다.

CDP 의 권한 부여는 **프로필이 아니라 DevTools 연결에 묶인다.** tirno 는 명령마다 붙었다
끊으므로, `cdp Browser.grantPermissions` 로 직접 준 권한은 그 명령이 끝나는 순간 `prompt`
로 돌아간다 — user-data-dir 을 유지해도 마찬가지다. 그래서 grant 는 `SessionMetadata.permissions`
에 저장되고 emulation 과 같은 자리에서 connect 마다 재적용된다.

권한이 있어도 `navigator.clipboard.readText()` 는 문서에 포커스가 없으면
`NotAllowedError: Document is not focused` 로 거절된다. 백그라운드 탭이면 `cdp Page.bringToFront`
를 먼저 보낸다.

### 자기 갱신
| 명령 | 설명 |
|---|---|
| `update [--check] [--binary-only] [--skills-only]` | 최신 릴리즈로 올린다 — 도는 바이너리를 제자리에서 갈아 끼우고, 스킬 플러그인은 `claude plugin` 으로 새로 당긴다 |

바이너리는 **bun 으로 컴파일한 단일 실행 파일일 때만** 갈아 낀다. `node bin/tirno.js`·`bun run`·
npm link 는 `process.execPath` 가 런타임을 가리키므로 대상이 아니다 — 그대로 두면 런타임을
덮어쓴다. 소스 체크아웃은 `git pull && npm run build`.

받은 파일은 릴리즈의 `SHA256SUMS` 와 대조하고, 항목이 없거나 어긋나면 설치하지 않는다.
같은 디렉터리에 받아 `rename` 으로 바꿔치우므로 도중에 죽어도 반쯤 쓰인 바이너리가 남지
않고, 실행 중인 자기 자신을 덮어써도 지금 프로세스는 옛 inode 로 끝까지 돈다.

스킬은 파일을 직접 만지지 않는다. Claude Code 가 플러그인을 자기 상태로 관리하므로
`claude plugin marketplace update tirno` → `claude plugin update tirno@tirno` 를 부른다 —
마켓플레이스를 먼저 당기지 않으면 옛 매니페스트를 보고 "최신" 이라고 답한다.
`claude` 가 PATH 에 없으면 그 두 줄을 안내하고 바이너리만 올린다.

**바이너리와 플러그인은 따로 설치되고 따로 낡으므로 각각 판정한다.** 릴리즈 바이너리를 직접
받아 쓰다가 `update` 로 갈아타면 바이너리만 최신이고 플러그인은 처음 설치 시점에 멈춰 있다.
플러그인 설치 버전과 **식별자**는 `~/.claude/plugins/installed_plugins.json`(또는
`CLAUDE_CONFIG_DIR`)에서 함께 읽는다. `claude plugin` 은 `<플러그인>@<마켓플레이스>` 를
요구하고 이름만 넘기면 "not found" 로 끝나는데, 그 이름을 갱신할 때 다시 지어내면 버전을
읽은 곳과 어긋날 수 있다 — 마켓플레이스 이름은 `marketplace.json` 이 정하므로 저장소를
fork 하면 달라진다. 설치된 키가 하나뿐인 출처다.

```
$ tirno update --check
binary  0.2.2    · latest 0.2.2 · up to date
plugin  0.2.0    · latest 0.2.2 · behind
→ Run "tirno update" to move both to 0.2.2.
```

### 서비스워커 (sw-proxy 조회)
| 명령 | 설명 |
|---|---|
| `sw status [--paths] [--json]` | 등록된 워커, 그 워커가 Cache Storage 에서 내고 있는 경로, 그리고 control 엔드포인트가 응답하면 레이어별 enabled·fetched(이번 SW 인스턴스 fetch 횟수, 캐시 히트는 0)·paths |
| — | + **Served by**: 현재 문서가 오버레이(`tirno-sw/…`)에서 왔나 원본에서 왔나. CONTROLS=yes 여도 원본일 수 있다(navigateFallback 없이 하위 경로 착지) |

정본은 **등록 정보와 Cache Storage** 다. sw-proxy 자신의 `<scope>__tirno/status` 만 믿으면
안 되는 이유는 실측으로 확인했다 — 워커는 자기 스크립트를 내주던 로컬 서버보다 오래 살고,
프로필에는 이 CLI 가 굽지 않은 워커도 들어 있을 수 있다. 그런 세션에서는 스크립트가 origin
에서 404 이고 control 요청에 사이트의 HTML 이 돌아오는데, 프록시되는 경로 22개는 Cache
Storage 에 그대로 남아 계속 서빙되고 있었다. control 응답은 답하는 워커에 한해 얹는다.

### 성능
| 명령 | 설명 |
|---|---|
| `stall [--window <s>]` | 메인스레드가 포화됐나, 무엇이 먹나. 렌더러 밖(브라우저 타깃)에서 재므로 페이지가 멈춰 DevTools 가 안 열려도 계속 관측된다 |
| `audit [url]` | Lighthouse. 세션의 chrome 을 재사용한다 |
| `trace --duration <s>` | chrome://tracing 호환 JSON |
| `trace start` · `trace stop` · `trace insight <path>` | 상주 워커로 구간 트레이스, LCP / FCP / CLS / long task 추출 |
| `memory` · `memory load <p>` · `memory details <p>` | heap snapshot, 요약, 타입별 retained size |
| `screencast start` · `screencast stop` | 프레임 연속 캡처 |
| `diff <s1> <s2>` | 두 세션 시각 diff (pixelmatch) |

### Visual cache (viewport-aware)
| 명령 | 설명 |
|---|---|
| `cache list [--domain <d>] [--limit <n>]` | (URL × viewport)별 캐시 entry 목록 |
| `cache load <url> [--mode exact\|urlPath] [--viewport <wxh@dpr>]` | 캐시된 항목을 **출력**한다 — a11y(role·name)와 bbox. viewport 미지정 시 가장 최근 |
| `cache prune (--older-than <days> \| --all) [--domain <d>]` | 정리. **나이나 `--all` 중 하나를 반드시 준다** — 무인자로 전량을 지우지 않는다 |

저장 구조: `~/.tirno/visual-cache/<domain>/<sha1(urlPath)>/<wxh@dpr>.json`. 같은 URL이라도 viewport가 다르면(데스크톱 vs 모바일 emulate) 별개 entry로 공존. bbox는 viewport 종속이라 layout journaling엔 viewport 분리가 필수.

**지금 담기는 채널은 `a11y`(role·name·backendId)와 `visual`(bbox) 둘뿐이다.** `backendId` 는
페이지가 다시 뜨면 무효라, 세션을 넘겨 재사용할 수 있는 것은 bbox 하나다. `dom.selector` 는
`record`/`trail` 경로에서만 저장된다.

`cache load` 는 **출력만 하고 ref store 를 채우지 않는다.** 꺼낸 `@N` 으로 바로 `click` 하면
`Unknown ref` 로 실패하므로, 조작하려면 `snapshot` 을 다시 찍어야 한다.

`visualFp`(dHash)는 저장되지만 **비교하는 코드가 없다** — 페이지가 바뀌어도 캐시는 그대로
나온다. 유효한지는 부르는 쪽이 판단한다.

셋 다 목표에 못 미친 상태고, [README 의 drift 절](../README.md#아직-구현이-아닌-것-drift)에
같이 적어뒀다.

### 기록 · 재생

한 번 성공한 조작 순서를 파일로 남겨 그대로 다시 태운다. 리스너는 **페이지 쪽에서** 돌고
버퍼가 localStorage 라, SPA 라우트 변경이나 새로고침을 넘겨도 이어서 잡힌다.

| 명령 | 설명 |
|---|---|
| `record start` | 기록 시작 |
| `record stop [--save <name>] [--json]` | 중지. `--save` 없으면 화면에만 출력 |
| `record list` / `record rm <name>` | 목록 / 삭제 |
| `replay <name> [--speed <n>] [--max-gap <ms>] [--no-nav] [--verbose]` | 재생. **원시 CDP 로 신뢰된(trusted) 이벤트**를 쏘므로 `isTrusted` 를 보는 사이트에서도 먹는다 |

재생은 단일 채널이 아니다 — `dom → a11y → bbox → event.xy` 순으로 내려가며 요소를 다시
찾는다. 앞 채널이 DOM 변경으로 깨져도 뒤 채널이 받는다.

### 사용자 시연 (trail) — 마지막 보루

`trail` 은 **자율 시도가 전부 실패했을 때만** 쓴다. 캐시도, 다중 채널도, CDP 직접 분석도
길을 못 찾은 경우에 한해 사람에게 시연을 부탁하고 그 경로를 기록한다. 호출 빈도가
줄어드는 것이 목표인 기능이다.

| 명령 | 설명 |
|---|---|
| `trail capture <name> [--goal <설명>]` | 시연 캡처 시작. `--goal` 로 "무엇을 하려던 것인가" 를 같이 남긴다 |
| `trail save [--name <override>]` | 캡처 중지 + 저장 |
| `trail list` / `trail show <name>` | 목록 / 단계별 채널 정보 |
| `trail replay <name> [--speed <n>] [--verbose]` | 재생 (record 와 같은 다중 채널 fallback) |
| `trail rm <name>` | 삭제 |

`record` 와 저장소가 갈려 있는 이유는 성격이 달라서다 — `record` 는 내가 성공시킨 순서,
`trail` 은 사람에게 빚진 순서다. 후자가 늘면 도구가 못하고 있다는 신호다.

### 종료코드

실패는 전부 **exit 1** 이다 — 실패한 navigation, 없는 세션, 거부된 kill, `broadcast` 의
부분 실패(자식 하나만 죽어도), `eval` 이 페이지에서 받은 예외까지. 종류별로 코드를 나누지
않으므로 `$?` 하나만 보면 된다.

`drift` 는 선언한 플래그와 실행 중 프로세스가 다르면 1 로 끝나므로 그대로 게이트가 된다.

### 자기기술

| 명령 | 설명 |
|---|---|
| `schema [--pretty]` | 전 명령 트리를 JSON 으로. 구조는 commander 에서 실행 시점에 뽑으므로 CLI 와 어긋날 수 없다 |
| `stats [--json] [--since <iso>]` | `~/.tirno/metrics.jsonl` 집계 |

`schema` 는 [The CLI Spec v0.3](https://clispec.dev) 형식에 `destructive` 하나를 더한다.
스펙의 `effects`(`read_only`/`idempotent`/`non_idempotent`)로는 "이건 로그인된 브라우저
프로필을 지운다" 를 말할 수 없는데, 호출하는 쪽이 실행 전에 알아야 하는 건 정확히 그것이다.

```bash
tirno schema | jq -r '.commands[] | select(.destructive) | .name'
# cache prune / close-tab / gc / kill / record rm / restart / trail rm
```

`--help` 를 파싱하지 말 것. 산문이라 하위 명령이 한 단 아래 숨고 여러 줄 설명이 명령 목록과
뒤섞여서, 긁으면 **존재하지 않는 플래그가 나온다**(실제로 그렇게 만든 문서를 한 번 고쳤다).

### 설치 크기

런타임 의존 **6개**, **약 200MB, 네이티브 바이너리 0개.**

무거운 것은 전부 들어냈다 — 실제로 안 쓰이는데 974MB 를 받게 했기 때문이다.

- **OCR 없음.** `tirno vision` 과 `snapshot --vision*` 제거(2026-08-19). `onnxruntime-node`
  259MB 를 끌고 오면서 한 번도 쓰이지 않았고, `florence` 백엔드는 자기 소스에 고장났다고
  적혀 있었다.
- **LLM 없음.** `tirno ask` / `tirno explore` / `tirno auth` 와 RAG 부속 제거(같은 날).
  성공 경로가 검증된 적이 없다 — 남아 있던 `explore` 실행 기록 8건은 전부 스모크가 실패를
  기대하고 부른 것이었다. **지능은 tirno 를 호출하는 쪽이 갖는다** — 이 도구는 결정론적인
  관측과 조작만 한다.

되살릴 때는 플러그인으로 붙인다.

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
| `~/.tirno/visual-cache/<domain>/<sha1(urlPath)>/<wxh@dpr>.json` | snapshot 캐시. URL **과 viewport** 둘 다가 키다 |
| `~/.tirno/recordings/` | `record --save` 산출물 |
| `~/.tirno/trails/` · `~/.tirno/active-trail.json` | 사용자 시연 기록 · 캡처 중인 것 |
| `~/.tirno/metrics.jsonl` | `stats` 가 읽는 이벤트 로그 |
| `~/.tirno/tmp/` | 스크린샷 기본 출력 위치 |
| `~/.tirno/active` | 현재 active 세션 |
| `~/.tirno/config.json` | `chrome set` 이 적어둔 Chrome 실행 파일 경로 |

`~/.tirno/models/` 가 있다면 지워도 된다 — 삭제된 OCR 백엔드가 받아둔 것으로, 지금 코드는
참조하지 않는다(수백 MB 를 차지한다).

### 환경변수

| 이름 | 기본값 | 용도 |
|---|---|---|
| `TIRNO_DIR` | `~/.tirno` | 데이터 루트 전체 |
| `TIRNO_CHROME` | (없음) | Chrome 실행 파일. 설정 파일보다 우선 |
| `CHROME_PATH` · `PUPPETEER_EXECUTABLE_PATH` | (없음) | 같은 용도. `TIRNO_CHROME` 다음 순서로 본다 |
| `TIRNO_CACHE_DIR` | `<루트>/visual-cache` | visual cache |
| `TIRNO_RECORDINGS_DIR` | `<루트>/recordings` | 기록 |
| `TIRNO_TRAILS_DIR` | `<루트>/trails` | 시연 |
| `TIRNO_METRICS` | (없음) | `0` 이면 메트릭 기록 끔 |
| `TIRNO_METRICS_FILE` | `<루트>/metrics.jsonl` | 메트릭 로그 위치 |

`TIRNO_DIR` 하나로 위 표의 **모든** 경로가 옮겨간다 — 테스트와 스모크가 실제 `~/.tirno`
와 격리되는 수단이 이것이다. 저장소별 변수는 루트보다 우선하므로, 하나만 다른 곳에 두고
싶을 때 쓴다.

`test/paths.test.ts` 와 스모크의 격리 검사가 이 약속을 지킨다 — 저장소 하나라도 루트 밖으로
새면 실패한다. 예전에는 새는 저장소가 있었고, 그래서 스모크의 `cache prune` 이 매 실행마다
사용자의 실제 캐시를 비웠다.