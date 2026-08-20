# tirno

[![ci](https://github.com/Rockheung/tirno/actions/workflows/ci.yml/badge.svg)](https://github.com/Rockheung/tirno/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![commands](https://img.shields.io/badge/commands-66-blue)
![license](https://img.shields.io/badge/license-ISC-lightgrey)

**여러 Chrome 을 세션으로 굴리는 CLI.** raw CDP 위에 얹혀 있고, 안에 LLM 이 없다 —
보고, 적고, 다시 꺼내 준다. 무엇을 할지는 부르는 쪽이 정한다.

에이전트가 사이트를 돌아다니며 알아낸 것을 누적하고, 다음 시도에 즉시 재사용하는 게 목표다.

```bash
git clone https://github.com/Rockheung/tirno.git && cd tirno
npm install && npm run build && npm link

tirno new demo https://example.com --headless   # 세션 하나 — 0.6초
tirno snapshot                                  # a11y 트리를 @ref 로
tirno click @7                                  # 셀렉터를 몰라도 누른다
tirno kill demo --clean
```

**필요한 것**: Node 22+ · Chrome(경로 4곳 자동 탐색, 없으면 `--executable-path`).
npm 레지스트리에는 없다 — 소스에서 받는다.

---

## 왜 다른가

| | |
|---|---|
| **세션이 여럿이고 서로 격리된다** | `user-data-dir` 이 따로라 쿠키·로그인이 섞이지 않는다. 한 번 로그인해두면 그 세션에 계속 붙는다 |
| **소유권을 관찰로 판정한다** | pid 생존 ∧ 그 pid 가 그 포트를 청취 ∧ `--user-data-dir` 일치. 셋이 안 맞으면 **붙지도 죽이지도 않는다** — 남의 브라우저를 조종하거나 죽이는 사고를 구조적으로 막는다 |
| **셀렉터를 몰라도 조작한다** | `snapshot` 이 a11y 트리에 `@1 @2 …` 를 붙인다. `click @7` · `fill @39 "..."` |
| **본 것을 캐시한다** | URL × viewport 키로 ref·selector·bbox·dHash 를 적어두고, 재방문 시 `cache load` 로 즉시 꺼낸다 |
| **여러 대에 동시에** | `broadcast … --group <g>` — 순차가 아니라 동시. 8세션 기준 1.35s → 0.35s |
| **실패는 전부 exit 1** | 거부된 kill, `broadcast` 의 부분 실패, `eval` 이 페이지에서 받은 예외까지. `$?` 하나만 보면 된다 |

## 어디부터 볼까

| 문서 | 무엇 |
|---|---|
| [docs/ONBOARDING.md](docs/ONBOARDING.md) | **처음이라면 여기.** 설치부터 첫 세션까지, 자주 걸리는 자리와 그 메시지 |
| [docs/COMMANDS.md](docs/COMMANDS.md) | 66개 명령 reference · 소유권 · 앵커 · 데이터 위치 · 환경변수 |
| [AGENTS.md](AGENTS.md) | 에이전트가 읽을 것 — 명령·경계·함정 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 개발 · 테스트 · CI |
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
| **Emulation 영속** | device/network/cpu/dpr 을 한 번 적용하면 다음 명령에도 유지된다 |
| **앵커** | 브라우저 MCP 가 붙을 대상을 포트가 아니라 디렉터리로 고정 |

기본 viewport 는 **1920x1080** 으로 고정된다 — 스크린샷 재현성과 캐시의 viewport 키
정합성 때문이다. 바꾸려면 `tirno emulate --viewport <wxh>`.

이름은 요정어로 *지켜보는 자* (`tir-` — 보다·지키다). 개명 내력은
[docs/JOURNAL.md](docs/JOURNAL.md).

## 라이선스

ISC
