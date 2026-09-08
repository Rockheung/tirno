import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'puppeteer-core';
import { waitForBootPage, blankAnchorHint } from '../src/cdp/page-resolver.js';
import { bootUrlOf } from '../src/core/session-store.js';
import type { SessionMetadata } from '../src/core/session-store.js';

// `new` 는 chrome 에 URL 을 넘기고 DevTools 포트만 확인한 뒤 돌아왔다. 그 사이 탭은
// 아직 about:blank 이라, 바로 이어지는 `eval` 이 **에러 없이 0** 을 냈다 (#173).
// 앵커가 틀린 게 아니라 맞는 탭을 너무 일찍 읽은 것이라, 기다리는 것 외에 답이 없다.

const meta = (flags: string[]): SessionMetadata =>
  ({ chromeFlags: flags } as unknown as SessionMetadata);

test('부트 URL 은 플래그가 아닌 유일한 항목이다', () => {
  assert.equal(bootUrlOf(meta(['--headless', 'https://example.com'])), 'https://example.com');
  assert.equal(bootUrlOf(meta(['--headless', '--no-sandbox'])), undefined);
  assert.equal(bootUrlOf(meta([])), undefined);
  assert.equal(bootUrlOf({} as SessionMetadata), undefined);
});

test('커밋된 앵커에는 할 말이 없다', () => {
  assert.equal(blankAnchorHint('https://example.com', 'https://example.com'), null);
  // URL 없이 띄운 세션에서 about:blank 는 정상이다 — 경고하면 늑대 소년이 된다.
  assert.equal(blankAnchorHint('about:blank', undefined), null);
});

test('안 열린 앵커는 그 사실과 다음 수를 말한다', () => {
  for (const url of ['about:blank', '']) {
    const hint = blankAnchorHint(url, 'https://example.com');
    assert.ok(hint, `${JSON.stringify(url)} 에 안내가 없다`);
    // 0 이 페이지 이야기가 아니라는 것과, 무엇을 치면 되는지가 같이 있어야 한다.
    assert.match(hint, /https:\/\/example\.com/);
    assert.match(hint, /tirno nav https:\/\/example\.com/);
  }
});

interface FakePage { url: string; readyState?: string; throws?: boolean }

function fakeBrowser(frames: FakePage[][]): Browser {
  let i = 0;
  return {
    pages: async () => {
      const frame = frames[Math.min(i, frames.length - 1)];
      i += 1;
      return frame.map(f => ({
        url: () => f.url,
        evaluate: async () => {
          if (f.throws) throw new Error('Execution context was destroyed');
          return f.readyState ?? 'complete';
        },
      })) as unknown as Page[];
    },
  } as unknown as Browser;
}

test('커밋되고 파싱이 끝난 페이지를 돌려준다', async () => {
  const page = await waitForBootPage(fakeBrowser([[{ url: 'https://example.com' }]]), 1000);
  assert.ok(page);
  assert.equal(page.url(), 'https://example.com');
});

// 커밋만 보면 파싱 도중의 DOM 을 센다 — 0 이 아닐 뿐 여전히 틀린 값이고 더 헷갈린다.
test('아직 loading 이면 기다린다', async () => {
  const page = await waitForBootPage(fakeBrowser([
    [{ url: 'https://example.com', readyState: 'loading' }],
    [{ url: 'https://example.com', readyState: 'interactive' }],
  ]), 1000);
  assert.ok(page);
});

test('아직 커밋 안 된 탭은 앵커가 아니다', async () => {
  const t0 = Date.now();
  assert.equal(await waitForBootPage(fakeBrowser([[{ url: '' }, { url: 'about:blank' }]]), 300), null);
  assert.ok(Date.now() - t0 >= 300, '기다리지 않고 바로 포기했다');
});

// chrome://newtab 이 앵커가 되면 부트 URL 을 영영 안 기다린다.
test('chrome:// 과 devtools:// 는 앵커가 아니다', async () => {
  assert.equal(await waitForBootPage(fakeBrowser([
    [{ url: 'chrome://new-tab-page' }, { url: 'devtools://devtools/x.html' }],
  ]), 200), null);
});

// 네비게이션이 실행 컨텍스트를 갈아치우면 evaluate 가 던진다. 그것이 곧 '아직'이지
// 실패가 아니다 — 여기서 터지면 세션 생성이 페이지 사정으로 무너진다.
test('evaluate 가 던지면 다음 바퀴에 다시 본다', async () => {
  const page = await waitForBootPage(fakeBrowser([
    [{ url: 'https://example.com', throws: true }],
    [{ url: 'https://example.com' }],
  ]), 1000);
  assert.ok(page);
});
