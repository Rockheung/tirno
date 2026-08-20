# tirno

Multi-session browser automation CLI on raw CDP.

여러 Chrome 인스턴스를 세션으로 관리하고, CDP 명령을 CLI로 실행한다. agent가 사이트를 돌아다니며 알아낸 사실을 누적하고 다음 시도에 빠르게 재사용하는 게 목표.

## 핵심 컨셉

| 컨셉 | 설명 |
|---|---|
| **Multi-session** | `tirno new <name>`으로 독립 Chrome 인스턴스. user-data-dir 별도 → cookie/storage 격리. tmux 스타일 |
| **Stateless CLI** | 명령마다 connect/disconnect. daemon 없음 — `~/.tirno/sessions/<name>.json`에서 메타 복원 |
| **a11y `@ref`** | `tirno snapshot`이 accessibility tree에 `@1`, `@2` 식으로 ref 부여 → `click @7`, `fill @39 "..."` 가능 |
| **Visual cache (Phase 6-1)** | snapshot 종료 시 a11y refs + selector + bbox + 64bit dHash를 URL key별로 자동 캐시 → 재방문 시 `cache load`로 즉시 emit |
| **Broadcast** | `tirno broadcast nav <url>` — 모든 세션에 동시 명령 |
| **Emulation** | device/network/cpu/dpr emulation 영속 — 한번 적용하면 다음 명령에서도 유지 |

## 설치

```bash
git clone https://github.com/Rockheung/tirno
cd tirno
npm install
npm run build
node bin/tirno.js --help
```

전역 설치는 `npm link` 또는 `npm i -g .` 후 `tirno`로 호출.

요구사항: Node 22+, Google Chrome (`/Applications/Google Chrome.app` macOS 또는 `google-chrome` Linux).

## Quick start

```bash
# 세션 시작 + 페이지 열기
tirno new mysession
tirno nav https://example.com

# 스냅샷으로 element 식별
tirno snapshot
# @1  RootWebArea "Example Domain"
# @7  link "Learn more"

# ref로 클릭 / 입력
tirno click @7

# 캐시된 페이지 재로드
tirno cache load https://example.com

# 종료
tirno kill mysession
```

## 명령 reference

### 세션
| 명령 | 설명 |
|---|---|
| `new <name> [-- <chrome-flags>]` | 새 Chrome 세션 생성. `--`로 임의 flag 전달 (`--proxy-server`, `--host-resolver-rules` 등) |
| `ls` | 세션 목록 (port, status, proxy, emulation, last access) |
| `attach <name>` | active 세션 변경 |
| `kill [name]` | 세션 종료 |
| `rename <old> <new>` | 이름 변경 |
| `export <name>` | 메타데이터 출력 |

### 네비게이션
| 명령 | 설명 |
|---|---|
| `nav <url>` | URL로 이동 |
| `reload` / `back` / `forward` | 페이지 이력 제어 |
| `pages` / `select <pageId>` / `new-tab [url]` / `close-tab <pageId>` | 탭 제어 |

### 검사
| 명령 | 설명 |
|---|---|
| `screenshot [--full] [--out path]` | 스크린샷 |
| `snapshot [--no-cache] [--vision [backend]]` | a11y 트리 + visual cache 적재. `--vision`으로 OCR 보강 (default tesseract). 옵션: `--vision-lang`, `--vision-min-confidence`, `--vision-iou`, `--vision-contain` |
| `console [--type <t>]` | 콘솔 메시지 (한정적 — stateless 모델 한계) |
| `network [--type <t>]` | reload 후 2초간 network 캡처 |

### 입력
| 명령 | 설명 |
|---|---|
| `click <selector\|@N>` | 클릭 |
| `fill <selector\|@N> <value>` | input clear + type |
| `type <text>` / `press <key>` / `hover <selector>` | 키보드/마우스 |
| `scroll up\|down\|<pixels>` | 스크롤 |
| `wait <ms>` / `wait-for [selector] [--network-idle]` | 대기 |
| `upload <selector> <files...>` | 파일 업로드 |

### 실행 / emulation
| 명령 | 설명 |
|---|---|
| `eval <expression>` | 페이지에서 JS 실행 |
| `emulate [--device <name>] [--dpr <n>] [--network <p>] [--cpu <n>] [--reset]` | 영속 emulation |

### 성능
| 명령 | 설명 |
|---|---|
| `trace --duration <s>` | chrome://tracing 호환 JSON |
| `memory` | heap snapshot |
| `diff <s1> <s2>` | 두 세션 시각 diff (pixelmatch) |

### Visual cache (Phase 6-1, viewport-aware)
| 명령 | 설명 |
|---|---|
| `cache list [--domain <d>] [--limit <n>]` | (URL × viewport)별 캐시 entry 목록 |
| `cache load <url> [--mode exact\|urlPath] [--viewport <wxh@dpr>]` | 캐시된 ref + selector + bbox emit. viewport 미지정 시 가장 최근 |
| `cache prune [--older-than <days>] [--domain <d>]` | 정리 |

저장 구조: `~/.tirno/visual-cache/<domain>/<sha1(urlPath)>/<wxh@dpr>.json`. 같은 URL이라도 viewport가 다르면(데스크톱 vs 모바일 emulate) 별개 entry로 공존. bbox는 viewport 종속이라 layout journaling엔 viewport 분리가 필수.

### Vision OCR (Phase 6-2)
| 명령 | 설명 |
|---|---|
| `vision ocr [--backend <name>] [--lang <l>] [--full] [--out <path>] [--min-confidence <n>] [--paddle-models <dir>]` | 페이지 OCR — 단어/줄별 bbox + confidence |

backend 선택:
- `tesseract` (default) — light, 한국어/영어 동시 지원 (`--lang kor+eng`), word 단위
- `paddle` — PaddleOCR via @gutenye/ocr-node, line 단위, 영어 default. 한국어는 `--paddle-models <dir>` 로 PaddleOCR 한국어 det/rec/dict 지정
- `florence` — Florence-2 via `@huggingface/transformers`. **experimental** — 모델 로드/추론 인프라는 동작하나, transformers.js v4의 task token(`<OCR_WITH_REGION>`) 처리에 디코딩 버그가 있어 output 정확성 미흡. production 용도는 tesseract/paddle 권장. env: `TIRNO_FLORENCE_MODEL`, `TIRNO_FLORENCE_DTYPE` (q4|q8|fp32), `TIRNO_FLORENCE_DEBUG=1`

### Multi-session
| 명령 | 설명 |
|---|---|
| `broadcast <cmd> [args...]` | 모든 세션에 동시 명령 |

## 데이터 위치

| 경로 | 내용 |
|---|---|
| `~/.tirno/sessions/<name>.json` | 세션 메타 (port, pid, emulation 상태) |
| `~/.tirno/profiles/<name>/` | Chrome user-data-dir (cookies, storage) |
| `~/.tirno/refs/<name>.json` | snapshot의 ref → backendDOMNodeId 매핑 |
| `~/.tirno/visual-cache/<domain>/<sha1>.json` | URL-keyed snapshot 캐시 |
| `~/.tirno/active` | 현재 active 세션 |

환경변수: `TIRNO_CACHE_DIR`로 visual cache 위치 override (테스트용).

## 개발

```bash
npm install
npm run build           # tsc → dist/
npm run dev             # tsc --watch
npm test                # node:test, 의존성 0
```

## 라이선스

ISC

## 진행 상황

작업 일지는 [docs/JOURNAL.md](docs/JOURNAL.md), 비교 도구 리서치는 [docs/RESEARCH.md](docs/RESEARCH.md).
