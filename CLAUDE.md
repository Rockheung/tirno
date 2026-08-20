# CLAUDE.md

## 프로젝트 개요

tirno — Multi-session browser automation CLI on raw CDP.
여러 Chrome 인스턴스를 세션으로 관리하고, CDP 명령을 CLI로 실행한다.
puppeteer-core 기반.

## tirno 가치 흐름 (불변)

목표 도달 시도 우선순위 — 위에서 아래로 시도, 마지막은 자존심 굽혀 부탁:

1. **cache lookup** — 결정론, ms 단위
2. **multi-channel fallback** (selector → a11y → bbox → ocr text) — 결정론, ms 단위
3. **CDP 직접 분석 + page 자율 시도** — agent가 페이지 구조 뜯어보며 행동경로 발견
4. **LLM (지능요청) + RAG retrieval** — 비결정론, 비용 있음, 누적된 trail/waypoint를 prompt에 RAG
5. **사용자 시연 부탁** (`tirno trail capture`) — **마지막 보루**. 위 모두 실패 시 자존심 굽혀 부탁. 부담을 인정하고 명시적으로 요청.

`record / replay / trail capture`는 5번에 해당. tirno의 메인 가치는 1~4의 자율 흐름. 메인 흐름이 강해질수록 5번 호출 빈도가 줄어드는 게 self-journaling의 진짜 의의.

## tirno 작업 원칙 (불변)

- **삽질을 통해 성공 경로를 기록.** 첫 시도 실패 시 다양한 우회로를 끝까지 시도하되, 발견한 사실(성공/실패 모두)은 cache/journal에 기록한다.
- **성공 패턴을 효과적으로 재활용.** 같은 작업 반복 시 cache load로 즉시 재사용. 그 위에 매번 처음부터 분석 반복하지 않는다.
- **지시를 성공할 때까지 사용자를 찾지 않는다.** 본질적 차단(없는 자격, 권한 부재 등) 외에는 자율 시도. 막힌 경우에도 모든 시도 흔적을 정리한 후 명확한 결과 보고. "할까요?" 같은 중간 확인은 작업 자율성을 깨뜨리므로 금지.
- 위 세 항목은 RESEARCH.md의 "agent self-journaling" 컨셉과 일치 — tirno의 존재 이유.
- **default viewport는 1920x1080.** layout/스크린샷 재현성과 visual cache의 viewport-key 매칭 정합성 위해 고정. `tirno new` 시 chrome flag로 자동 적용. 사용자가 다른 사이즈가 필요하면 `--` 뒤에 `--window-size=...` 또는 `tirno emulate --viewport <wxh>`로 명시.

## 빌드

```bash
npm install
npm run build    # tsc → dist/
```

## 테스트

```bash
npm test    # tsc -p tsconfig.test.json → node --test (유닛)
```

유닛 테스트는 **Chrome 을 띄우지 않는다.** `lsof` 출력·`DevToolsActivePort` 본문·chrome
커맨드라인은 전부 캡처한 문자열이고, 파일을 쓰는 테스트는 `mkdtempSync` + `TIRNO_DIR`
override 로 실제 `~/.tirno` 와 격리된다. 그래서 빠르고 호스트에 무관하지만, 증명하는 것은
**파서·판정 로직이지 Chrome 의 행동이 아니다** — 그쪽은 스모크로 확인한다:

```bash
node bin/tirno.js new test --headless --ephemeral
node bin/tirno.js nav https://example.com
node bin/tirno.js screenshot --out /tmp/test.png
node bin/tirno.js kill test --clean
```

## 구조

- `src/core/` — 세션 저장, Chrome 실행/연결, 프로세스 관리, ref store, 키체인, 메트릭,
  그리고 앵커 브로커 (`anchor-store` · `inventory`(소유권 판정) · `devtools-port` · `gc` ·
  `drift` · `path-guard`)
- `src/commands/` — CLI 명령. 파일명은 카테고리이지 명령 이름이 아니다 (`inspect.ts` 는
  screenshot/snapshot/console/network 를 등록한다 — `tirno inspect` 라는 명령은 없다)
- `src/cdp/` — 페이지 리졸버, emulation, dom-actions, element-info, iou, screenshot-hash
- `src/intelligence/` — LLM 백엔드, 임베딩, 재시도·비용 상한. `backends/` 에는 **`claude.ts`
  하나뿐이다** — openai·gemini 는 파일조차 없고 `dispatcher.ts` 가 던진다
- `src/vision/` — OCR 백엔드와 a11y 증강. 실제로 도는 것은 로컬 `paddle` 이고,
  `claude`·`openai`·`gemini` 는 파일은 있으나 전부 stub 이다 (`florence` 는 실험)
- `src/storage/` — visual cache / trail 저장소 (file · lance 백엔드)
- `src/output/` — 터미널 테이블, 스크린샷 파일 쓰기
- `core/schema.ts` — `tirno schema` 의 생성기. 구조는 commander 트리에서 자동 추출하고,
  의미(`effects`·`destructive`)만 `SEMANTICS` 표로 선언한다. 새 명령을 분류 없이 추가하면
  `test/schema.test.ts` 가 깨진다 — 그게 이 표가 안 낡는 이유다
- `src/util/` — 에러 타입, 인자 파서

## 의존성

- puppeteer-core: Chrome CDP 클라이언트
- commander: CLI 프레임워크
- chalk: 터미널 컬러
- pixelmatch + pngjs: 스크린샷 비교
- lighthouse: `tirno audit`
- @anthropic-ai/sdk: `tirno ask` / `tirno explore` 의 claude 백엔드.
  **지능 백엔드는 claude 하나뿐이다** — `--backend openai|gemini` 는 인자로 받지만
  `dispatcher.ts` 에서 "not yet implemented" 로 던진다
- @gutenye/ocr-node + @huggingface/transformers: OCR·임베딩 (가치 흐름 2·4번)
- @lancedb/lancedb: waypoint 벡터 검색 (RAG)
