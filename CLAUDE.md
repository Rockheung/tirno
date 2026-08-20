# CLAUDE.md

## 프로젝트 개요

wandr — Multi-session browser automation CLI on raw CDP.
여러 Chrome 인스턴스를 세션으로 관리하고, CDP 명령을 CLI로 실행한다.
puppeteer-core 기반.

## 빌드

```bash
npm install
npm run build    # tsc → dist/
```

## 테스트

```bash
node bin/wandr.js new test -- --no-proxy-server
node bin/wandr.js nav https://example.com
node bin/wandr.js screenshot --out /tmp/test.png
node bin/wandr.js kill test
```

## 구조

- `src/core/` — 세션 저장, 포트 할당, Chrome 실행/연결, 프로세스 관리, ref store
- `src/commands/` — CLI 명령 (session, nav, inspect, input, eval, emulate, perf, multi)
- `src/cdp/` — 페이지 리졸버, emulation, dom-actions
- `src/output/` — 터미널 테이블, 스크린샷 파일 쓰기
- `src/util/` — 에러 타입

## 의존성

- puppeteer-core: Chrome CDP 클라이언트
- commander: CLI 프레임워크
- chalk: 터미널 컬러
- pixelmatch + pngjs: 스크린샷 비교
