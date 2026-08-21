# AGENTS.md

tirno — raw CDP 위의 다중 세션 브라우저 자동화 CLI. **이 도구를 고칠 때**와 **이 도구를 쓸 때**
둘 다 여기에 적는다.

## Setup

받아서 쓸 거면 릴리즈의 바이너리가 빠르다 — 런타임이 들어 있어 Node 가 필요 없다.
`darwin-arm64` · `darwin-x64` · `linux-x64` · `linux-arm64` 넷이고 Windows 는 대상이 아니다.

고칠 거면 소스에서:

```bash
npm install
npm run build            # tsc → dist/. 안 하면 bin/tirno.js 가 아무것도 못 한다
npm test                 # 유닛 190건 (~0.6s, Chrome 안 띄움)
npm run lint             # eslint, 경고 0 유지
node scripts/smoke.mjs   # 전 명령 190건 (~55s, 진짜 Chrome + 네트워크)
```

`npm test` 와 스모크 **둘 다 PR 게이트**다(`.github/workflows/ci.yml`).
`gate-regression.yml` 은 Chrome 계약 확인용이고 수동 트리거다.

## 이 도구를 쓸 때

**능력은 `tirno schema` 에 묻는다.** `--help` 는 사람용 산문이라 서브커맨드가 최상위에
안 보이고, 긁으면 없는 플래그가 나온다. schema 는 commander 트리에서 실행 시점에 뽑는다.

```bash
tirno schema | jq '.commands[].name'                          # 66개
tirno schema | jq '.commands[] | select(.destructive) | .name' # 지우는 것부터 확인
```

```bash
tirno new s1 https://example.com --headless   # 세션 시작(+첫 URL)
tirno snapshot                                # a11y 트리 → @ref
tirno click @7 ; tirno fill @39 "값"          # ref 로 조작
tirno eval "document.title" -s s1             # 검증은 페이지에서 다시 읽는다
tirno kill s1 --clean
```

### 문법 함정 넷

- **`-s` 는 하위 명령 뒤에 온다.** `tirno eval "1+1" -s s1` ✓ / `tirno -s s1 eval …` ✗
- **`@ref` 는 세션마다·페이지마다 다시 찍는다.** 번호가 같아도 매핑은 세션별이고 이동하면
  무효다. `No node with given id found` 가 뜨면 `snapshot` 을 다시. 여러 세션이면
  `tirno broadcast snapshot --group <g>`
- **chrome 플래그는 `--` 뒤로.** `tirno new s1 -- --no-proxy-server`
- **실패는 전부 exit 1.** 종류별 코드가 없으므로 `$?` 하나만 본다

### 조작했다고 됐다고 하지 않는다

`click` 이 0으로 끝난 것은 "명령이 죽지 않았다"까지다. **페이지에서 결과를 다시 읽어
확인한 뒤에** 됐다고 한다 — `eval` 로 상태를 읽거나 `snapshot` 을 다시 찍는다.

### 남의 브라우저를 건드리지 않는다

소유권은 셋이 다 맞아야 `ours` 다: pid 생존 ∧ 그 pid 가 그 포트를 청취 ∧ `--user-data-dir`
일치. `foreign`/`ambiguous` 면 tirno 가 붙지도 죽이지도 않는다 — 그 거부를 우회하지 마라.
장부만 걷으려면 `tirno gc`(브라우저를 죽이지 않고 프로필도 안 지운다).

`pkill -f` · `killall` 금지. 프로세스를 죽여야 하면 PID 로만.

## 이 도구를 고칠 때

- `src/commands/` — 파일명은 **카테고리이지 명령 이름이 아니다.** `inspect.ts` 가
  screenshot/snapshot/console/network 를 등록한다
- `src/core/` — 세션 저장, chrome 실행/연결, 소유권 판정, 앵커, 경로 루트(`paths.ts`)
- `src/cdp/` — 페이지 리졸버, emulation, dom-actions
- `src/core/schema.ts` — 새 명령을 `SEMANTICS` 에 분류 없이 추가하면 `test/schema.test.ts`
  가 깨진다. 그게 이 표가 안 낡는 이유다
- `.claude/skills/` — 스킬 원본. `plugins/tirno/skills/<이름>/SKILL.md` 는 사본이고,
  고쳤으면 `cp` 로 맞춘다(`test/plugin-skills.test.ts` 가 어긋나면 깨뜨린다)
- `plugins/tirno/skills/tirno-sw-override/scripts/` — sw-proxy 생성기. 스킬 안에 있어야
  플러그인으로 설치했을 때도 딸려간다

### 지켜지는 불변식 (깨면 검사가 잡는다)

- **모든 저장소는 `TIRNO_DIR` 아래.** `os.homedir()` 로 경로를 직접 만들지 마라 —
  `core/paths.ts` 의 `underRoot()` 를 쓴다. `test/paths.test.ts` 가 홈 유출을 잡는다
- **사용자에게 닿는 문자열 속 `tirno <cmd>` 는 실존해야 한다.** `test/schema.test.ts` 가
  schema 와 대조한다
- **스모크의 `known` 표시는 고쳐지면 `STALE` 로 실패한다.** 결함이 사라졌는데 표시가 남으면
  그 검사는 아무것도 안 지키므로, 표시를 떼라고 알린다
- **버전은 세 곳이 같아야 한다** — `package.json` · `src/main.ts` 의 `.version()` ·
  플러그인 매니페스트. 릴리즈 태그와 바이너리의 `--version` 이 다르면 안 된다

### 커밋 · PR

- main 직접 push 금지. 브랜치 → PR → squash 병합
- 커밋 메시지와 PR 본문은 한국어. 무엇이 왜 이렇게 됐는지를 적고, 삽질 과정은 적지 않는다
- 검사를 추가했으면 **일부러 깨뜨려 실제로 실패하는지 확인**한다. 안 깨지는 검사는 검사가 아니다

## 경계

**tirno 안에 LLM 이 없다.** 판단이 필요한 일은 tirno 를 호출하는 쪽이 한다. 이 도구는
결정론적인 관측과 조작만 제공하고, 그 경계를 흐리는 기능은 넣지 않는다.

더 읽을 것: [docs/ONBOARDING.md](docs/ONBOARDING.md) · [docs/COMMANDS.md](docs/COMMANDS.md) ·
[CONTRIBUTING.md](CONTRIBUTING.md)
