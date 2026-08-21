# tirno

[![ci](https://github.com/Rockheung/tirno/actions/workflows/ci.yml/badge.svg)](https://github.com/Rockheung/tirno/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![commands](https://img.shields.io/badge/commands-66-blue)
![license](https://img.shields.io/badge/license-ISC-lightgrey)

**여러 Chrome 을 세션으로 굴리는 CLI.** raw CDP 위에 얹혀 있고, 안에 LLM 이 없다 —
보고, 적고, 다시 꺼내 준다. 무엇을 할지는 부르는 쪽이 정한다.

에이전트가 사이트를 돌아다니며 알아낸 것을 적어두고, 다음 시도에 다시 꺼내 쓰자는 게 목표다.
어디까지 왔는지는 [아직 구현이 아닌 것](#아직-구현이-아닌-것-drift)에 적어뒀다.

```bash
# 받아서 바로 — Node 없이 돈다 (macOS arm64; 다른 타깃은 릴리즈 페이지에)
curl -fsSL https://github.com/Rockheung/tirno/releases/latest/download/tirno-bun-darwin-arm64 -o tirno
chmod +x tirno && sudo mv tirno /usr/local/bin/

tirno new demo https://example.com --headless   # 세션 하나 — 0.6초
tirno snapshot                                  # a11y 트리를 @ref 로
tirno click @7                                  # 셀렉터를 몰라도 누른다
tirno kill demo --clean
```

**필요한 것**: Chrome 하나뿐이다(경로 4곳 자동 탐색, 없으면 `--executable-path`).
바이너리에 런타임이 들어 있어 Node 를 안 깔아도 된다.

바이너리는 넷이다 — `darwin-arm64` · `darwin-x64` · `linux-x64` · `linux-arm64`.
**Windows 는 대상이 아니다**: 소유권 판정이 `lsof` 와 `ps` 를 읽는다.
릴리즈의 `SHA256SUMS` 로 검증할 수 있다.

<details>
<summary>소스에서 (고칠 사람)</summary>

```bash
git clone https://github.com/Rockheung/tirno.git && cd tirno
npm install && npm run build && npm link
```

Node 22+ 가 필요하다. npm 레지스트리에는 올라가 있지 않다.
</details>

---

## 왜 다른가

| | |
|---|---|
| **세션이 여럿이고 서로 격리된다** | `user-data-dir` 이 따로라 쿠키·로그인이 섞이지 않는다. 한 번 로그인해두면 그 세션에 계속 붙는다 |
| **소유권을 관찰로 판정한다** | pid 생존 ∧ 그 pid 가 그 포트를 청취 ∧ `--user-data-dir` 일치. 셋이 안 맞으면 **붙지도 죽이지도 않는다** — 남의 브라우저를 조종하거나 죽이는 사고를 구조적으로 막는다 |
| **셀렉터를 몰라도 조작한다** | `snapshot` 이 a11y 트리에 `@1 @2 …` 를 붙인다. `click @7` · `fill @39 "..."` |
| **본 것을 적어둔다** | `snapshot` 이 URL × viewport 키로 a11y(role·name)와 bbox 를 저장한다. 재방문 시 `cache load` 로 **꺼내 볼 수 있다** — 조작하려면 `snapshot` 을 다시 찍어야 한다([아래](#아직-구현이-아닌-것-drift)) |
| **여러 대에 동시에** | `broadcast … --group <g>` — 순차가 아니라 동시. 8세션 기준 1.35s → 0.35s |
| **실패는 전부 exit 1** | 거부된 kill, `broadcast` 의 부분 실패, `eval` 이 페이지에서 받은 예외까지. `$?` 하나만 보면 된다 |

## 스킬 — 에이전트에게 시키려면

이 레포는 자기 스킬의 마켓플레이스이기도 하다.

```bash
claude plugin marketplace add Rockheung/tirno
claude plugin install tirno@tirno
```

넷이 들어온다 — `tirno`(명령 레퍼런스) · `tirno-runbook`(작업 절차) ·
`tirno-mcp`(chrome-devtools-mcp 대응) · `tirno-sw-override`(배포 전 빌드를 진짜 origin 에 얹기).

스킬 본문은 `.claude/skills/` 가 정본이고 `plugins/tirno/skills/` 는 그리로 걸린 심링크다 —
복사본이 낡는 일이 없다.

## 어디부터 볼까

| 문서 | 무엇 |
|---|---|
| [docs/ONBOARDING.md](docs/ONBOARDING.md) | **처음이라면 여기.** 설치부터 첫 세션까지, 자주 걸리는 자리와 그 메시지 |
| [docs/COMMANDS.md](docs/COMMANDS.md) | 70개 명령 reference · 소유권 · 앵커 · 데이터 위치 · 환경변수 |
| [AGENTS.md](AGENTS.md) | 에이전트가 읽을 것 — 명령·경계·함정 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 개발 · 테스트 · CI |
| [docs/research-sw-cdn-proxy.md](docs/research-sw-cdn-proxy.md) | 배포 전 빌드를 진짜 origin 위에 얹기 — 서비스워커 오버레이 설계 |
| [docs/JOURNAL.md](docs/JOURNAL.md) · [docs/RESEARCH.md](docs/RESEARCH.md) | 작업 일지 · 비교 도구 리서치 |

명령 표면의 **정본은 `tirno schema`** 다. commander 트리에서 실행 시점에 뽑으므로 문서보다
늦지 않고, 명령마다 `effects` 와 `destructive` 가 붙어 있어 실행 전에 무엇이 지워지는지 알 수 있다.

```bash
tirno schema | jq '.commands[] | select(.destructive) | .name'
```

## 핵심 개념

| 개념 | 설명 |
|---|---|
| **Multi-session** | `tirno new <name>` 으로 독립 Chrome. tmux 스타일 |
| **Stateless CLI** | 명령마다 connect/disconnect. daemon 없음 — `~/.tirno/sessions/<name>.json` 에서 메타 복원 |
| **a11y `@ref`** | `snapshot` 이 붙인 번호. **세션마다·페이지마다 다시 찍는다** |
| **Visual cache** | URL **과 viewport** 둘 다가 키다. bbox 는 viewport 종속이라 분리가 필수 |
| **다채널 fallback** | `replay`·`trail replay` 가 `dom.selector → a11y → bbox → 기록 좌표` 순으로 대상을 다시 찾는다. **캐시 경로에는 아직 없다** |
| **Emulation 영속** | device/network/cpu/dpr 을 한 번 적용하면 다음 명령에도 유지된다 |
| **앵커** | 브라우저 MCP 가 붙을 대상을 포트가 아니라 디렉터리로 고정 |

기본 viewport 는 **1920x1080** 으로 고정된다 — 스크린샷 재현성과 캐시의 viewport 키
정합성 때문이다. 바꾸려면 `tirno emulate --viewport <wxh>`.

이름은 요정어로 *지켜보는 자* (`tir-` — 보다·지키다). 개명 내력은
[docs/JOURNAL.md](docs/JOURNAL.md).

## 아직 구현이 아닌 것 (drift)

문서가 앞서 있던 것을 실측해 내렸다. 목표는 여전하지만 지금 코드는 여기까지다.

| 하고 싶은 것 | 지금 | 근거 |
|---|---|---|
| 캐시에서 꺼낸 ref 로 **바로 조작** | `cache load` 는 출력만 하고 ref store 를 안 채운다. `click @7` 은 `Unknown ref` 로 실패하고, `snapshot` 을 다시 찍어야 한다 | 새 세션에서 실행 확인 |
| 캐시에 **selector** 를 담기 | `snapshot` 이 담는 채널은 `a11y`(role·name·backendId)와 `visual`(bbox) 둘뿐이다. `backendId` 는 페이지가 다시 뜨면 무효라, 세션을 넘겨 쓸 수 있는 건 bbox 하나다 | 캐시 파일의 채널 분포 실측 |
| 캐시가 **낡았는지 판정** | `visualFp`(dHash)를 저장은 하지만 비교하는 코드가 없다 — 페이지가 바뀌어도 그대로 나온다. 유효성 판단은 부르는 쪽 몫이다 | `hammingDistance` 호출자 0건 |

**다채널 fallback 은 `record`/`trail` 쪽에서는 실제로 돈다** — `replay` 가
`dom.selector → a11y(role+name) → bbox → 기록 좌표` 순으로 되찾는다. 캐시 경로가 그
수준에 아직 못 미친 것이다.

## 라이선스

ISC
