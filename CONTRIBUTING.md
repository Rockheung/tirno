# 기여

## 개발

```bash
npm install
npm run build           # tsc → dist/
npm run dev             # tsc --watch
npm test                # tsc -p tsconfig.test.json → node --test
npm run lint            # eslint
```

유닛 테스트는 Chrome 을 띄우지 않는다 — `lsof` 출력·`DevToolsActivePort` 본문·chrome
커맨드라인이 전부 캡처된 문자열이다. 그래서 빠르지만 증명하는 것은 **파서·판정 로직이지
Chrome 의 행동이 아니다.** 그쪽은 스모크가 본다:

```bash
node scripts/smoke.mjs   # 전 명령 실행. PR 게이트가 이걸 그대로 돌린다
```