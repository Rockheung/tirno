# Multi-browser support research

> tirno 가 puppeteer-core CDP로 Chrome 지원 중. Firefox / Safari / WebKit 추가 가능 여부 + 비용 + 결정 분기점.

조사 시점: 2026-05-07.

---

## 결과 요약

| 브라우저 | 지원 가능 | protocol | tirno 추가 비용 | 권장 |
|---|---|---|---|---|
| **Chrome / Chromium / Edge** | ✅ 현재 지원 | CDP (Chrome DevTools Protocol) | — | 메인 |
| **Firefox** | ✅ 가능 (작음) | WebDriver BiDi | 의존성 0 추가, launch path만 분기 | **다음 단계로 채택 권장** |
| **Safari (macOS)** | △ 가능 (중간) | WebDriver (safaridriver) | 별도 driver layer 필요 (selenium-webdriver 등 dep) | macOS only면 의미. 우선순위 낮음 |
| **WebKit (cross-platform)** | ❌ 사실상 불가 | Playwright의 patched WebKit + 자체 protocol | puppeteer로는 불가. Playwright 전환 또는 dual-runtime | 비용 vs 가치 매우 큼 |

---

## 1. Firefox — WebDriver BiDi (실현 가능, 작은 비용)

### 현재 상태
- **Puppeteer 23.0.0+**: production-ready Firefox 지원 ([Chrome Developers blog](https://developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi))
- protocol: **WebDriver BiDi** (W3C 표준, Mozilla + Google 공동 개발)
- Puppeteer가 Firefox launch 시 자동으로 BiDi 활성화
- tirno 의 `puppeteer-core ^24.0.0` 이미 호환

### 변경 필요한 것
- `chrome-launcher.ts` → `browser-launcher.ts` 으로 일반화
  - `puppeteer.launch({ browser: 'firefox', executablePath: ... })`
  - Firefox 경로 자동 탐지 (`/Applications/Firefox.app/.../firefox-bin`, `/usr/bin/firefox`)
- `tirno new` 에 `--browser firefox|chrome` 옵션
- session metadata에 `browser` 필드
- emulation: Firefox는 일부 CDP 명령 미지원 → BiDi equivalent 사용 또는 graceful skip

### CDP / BiDi 차이로 영향 받는 기능
- ✅ Navigation / click / fill / scroll / screenshot — BiDi 표준
- ✅ a11y tree (`Accessibility.getFullAXTree` 동등 — BiDi `browsingContext.locateNodes`)
- ⚠️ `Input.dispatchMouseEvent` 직접 호출 → BiDi `input.performActions` 로 매핑 필요 (raw `tirno cdp` 명령은 Chrome 전용으로 한정)
- ⚠️ `Input.setInterceptDrags` — Firefox 미지원 (Chrome 한정 영역)
- ✅ network / console — BiDi `network.*` / `log.*` 도메인
- ⚠️ `Page.setBypassCSP`, `Page.setInterceptDrags` 등 Chrome-only 필드 → 우회 또는 graceful disable

### 이미 갖춰진 부분
- `tirno cdp` raw passthrough는 Chrome session 가정 — Firefox 모드에선 `tirno bidi` 별도 명령 또는 unified wrapper 추가 필요
- vision OCR / record / replay / explore 흐름은 protocol 무관 — 채널이 selector / a11y / bbox / coords 면 다 동작

### 추정 작업량
**중**. PR 1~2개. Firefox 환경 빌드 검증 필요.

---

## 2. Safari (macOS 한정) — safaridriver (WebDriver)

### 현재 상태
- Safari 10+ 부터 `safaridriver` 내장 — 별도 download 불필요 ([LambdaTest guide](https://www.lambdatest.com/blog/selenium-safaridriver-macos/))
- 사용 전 한 번: `Develop > Allow Remote Automation` 메뉴 활성화 필요 ([Apple WebDriver docs](https://developer.apple.com/documentation/safari-developer-tools/webdriver))
- protocol: **W3C WebDriver** (CDP 아님). BiDi는 Safari 25 (2025-09 발표)부터 부분 지원 — tirno 활용 가능 시점은 미정

### Puppeteer 지원
- ❌ **Puppeteer 미지원**. CDP가 Safari에 없고 BiDi도 puppeteer 측 미통합

### tirno 추가 비용
- Selenium WebDriver 또는 webdriverio 의존성 추가
- 별도 Driver layer (`SafariDriver` adapter)
- `tirno cdp` 같은 raw 명령은 Safari에서 의미 없음 → Safari 모드에선 다른 raw passthrough(`tirno wd`) 별도

### 가치
- macOS 사용자만 가치. Safari 점유율 자체는 desktop ~9% (statcounter), mobile 큼
- iOS Simulator의 mobile Safari는 별개 (Appium 같은 모바일 framework 영역)

### 권장
- 우선순위 낮음
- Firefox 추가 후 사용자 요청 있을 때

---

## 3. WebKit (cross-platform) — Playwright만 지원

### 현재 상태
- WebKit는 Safari의 엔진, 그러나 **Playwright는 자체적으로 patched WebKit binary를 download해 사용** ([Playwright vs Puppeteer 비교](https://www.browserstack.com/guide/playwright-vs-puppeteer))
- protocol: WebKit Inspector Protocol + Playwright 자체 patches
- macOS / Linux / Windows 모두에서 동작 (Safari engine을 OS 무관하게 쓸 수 있는 유일한 길)

### Puppeteer 지원
- ❌ **불가능**. WebKit은 CDP / BiDi 어느 것도 native 지원 안 함. Playwright의 patched WebKit는 Playwright 전용

### tirno 추가 비용
- **Playwright 전환** — 큰 변경. puppeteer-core를 playwright로
- 또는 **dual runtime** — Chrome/Firefox는 puppeteer, WebKit은 playwright. 인터페이스 추상화 필요
- 코드 50% 이상 영향. test 수정.

### 가치
- 진정한 cross-platform Safari 동작 검증이 필요한 경우만
- 일반 web automation에선 Chromium / Firefox로 충분 (Safari 호환성 issue는 별도 manual test)

### 권장
- 비추천. 가치 대비 비용 매우 큼. Playwright 자체 사용을 권장 (별도 도구로)

---

## 4. 결정 권장

### 단기 (다음 1~2 PR)
**Firefox 지원 추가**.
- puppeteer-core 24가 이미 BiDi 통한 Firefox 지원
- launch / nav / click / fill / a11y / screenshot — 표준 채널 다 동작
- record/replay/explore의 multi-channel design은 protocol 무관 → 그대로 작동
- `tirno cdp` Chrome-only인 점만 명시. Firefox 모드에선 BiDi 권장

### 중기 (사용자 요청 시)
**Safari (macOS 한정)** — webdriverio + safaridriver adapter.

### 장기 (별도 검토)
**WebKit cross-platform** — Playwright 전환 또는 dual runtime. 별도 큰 PR.

---

## 5. tirno multi-channel 모델과 protocol 무관성

tirno의 핵심 가치는 **selector / a11y / bbox / OCR 채널 묶음 + cache 누적 + LLM fallback + trail replay**. 이 흐름은 protocol-agnostic — 어떤 driver든 동등한 multi-channel 정보를 줄 수 있으면 그대로 동작.

protocol-specific 영역만 최소화:
- `chrome-launcher.ts` — browser-launcher 추상
- `chrome-connector.ts` — driver 추상 (CDP / BiDi / WebDriver)
- `tirno cdp` raw — driver별 passthrough (`tirno bidi`, `tirno wd`)

이 분리만 끝나면 새 browser 추가는 driver adapter 하나 더하는 식.

---

## 참고 자료

- [WebDriver BiDi production-ready in Firefox, Chrome and Puppeteer](https://developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi)
- [Puppeteer WebDriver BiDi 공식 문서](https://pptr.dev/webdriver-bidi)
- [Is Puppeteer ready for WebDriver BiDi yet?](https://puppeteer.github.io/ispuppeteerwebdriverbidiready/)
- [Mozilla WebDriver BiDi wiki](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi)
- [Apple WebDriver documentation](https://developer.apple.com/documentation/safari-developer-tools/webdriver)
- [Safari + safaridriver 가이드 (LambdaTest)](https://www.lambdatest.com/blog/selenium-safaridriver-macos/)
- [Playwright vs Puppeteer 2026 (BrowserStack)](https://www.browserstack.com/guide/playwright-vs-puppeteer)
- [WebdriverIO Automation Protocols](https://webdriver.io/docs/automationProtocols/)
- [Migrating from Puppeteer to Playwright](https://playwright.dev/docs/puppeteer)
