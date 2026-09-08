import type { Browser, Page } from 'puppeteer-core';

export async function getActivePage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  // filter out chrome:// and devtools:// pages
  const contentPages = pages.filter(p => {
    const url = p.url();
    return !url.startsWith('chrome://') && !url.startsWith('devtools://') && url !== 'about:blank';
  });

  if (contentPages.length > 0) return contentPages[contentPages.length - 1];
  if (pages.length > 0) return pages[0];

  return await browser.newPage();
}

/**
 * The same page as getActivePage, brought to the front first.
 *
 * puppeteer's mouse-driven actions (`page.click`, `page.hover`) wait for the
 * element to be visible and settled, and a backgrounded tab never gets there —
 * the command hangs forever with no error at all. Opening a second tab is
 * enough to trigger it, because the new tab takes the foreground.
 *
 * Only the commands that drive the mouse need this. The ones that go straight
 * through CDP — eval, screenshot, snapshot, type, scroll, upload — work on a
 * background tab and are left alone, so reading a page does not disturb which
 * tab the user is looking at.
 */
export async function getInteractivePage(browser: Browser): Promise<Page> {
  const page = await getActivePage(browser);
  await page.bringToFront();
  return page;
}

/** `page.url()` for a tab that has not committed a navigation yet. */
function uncommitted(url: string): boolean {
  return url === '' || url === 'about:blank';
}

/**
 * 부트 URL 이 실제로 커밋될 때까지 기다린다.
 *
 * `new` 는 chrome 에 URL 을 마지막 인자로 넘기고 DevTools 포트만 확인한 뒤 돌아온다.
 * 그 사이 탭은 아직 `about:blank` 이라, 바로 이어지는 `eval` 이 **에러 없이 0 을 낸다** —
 * 앵커가 틀린 것이 아니라 맞는 탭을 너무 일찍 읽은 것이라, 기다리는 것 말고는 답이 없다.
 * 실측으로 4초 걸리는 URL 에서 매번 재현됐다 (#173).
 *
 * 커밋만으로는 부족하다. 문서가 아직 `loading` 이면 DOM 을 세는 검증이 파싱 도중의
 * 숫자를 받는다 — 0 이 아닐 뿐 여전히 틀린 값이고, 그쪽이 알아보기 더 어렵다.
 *
 * 못 기다렸으면 null 이다. 세션은 이미 살아 있으므로 여기서 던지지 않는다 — 느린
 * 페이지 때문에 `new` 가 실패하면 그게 더 나쁘다. 부르는 쪽이 그 사실을 말한다.
 */
export async function waitForBootPage(browser: Browser, timeoutMs: number): Promise<Page | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const page of await browser.pages()) {
      const url = page.url();
      if (uncommitted(url) || url.startsWith('chrome://') || url.startsWith('devtools://')) continue;
      try {
        if (await page.evaluate(() => document.readyState) !== 'loading') return page;
      } catch {
        // 그 사이 네비게이션이 실행 컨텍스트를 갈아치웠다. 다음 바퀴에 다시 본다.
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * 앵커가 아직 안 열린 상태를 사람 말로 옮긴다. 아니면 null.
 *
 * `new` 가 기다리게 됐어도 이 자리는 남는다 — 기다림이 시간을 넘겼거나, 페이지가
 * 그 뒤에 `about:blank` 로 갔을 수 있다. 그때 조용히 0 을 내는 것이 이 결함의 본체였다.
 */
export function blankAnchorHint(pageUrl: string, bootUrl: string | undefined): string | null {
  if (!bootUrl || !uncommitted(pageUrl)) return null;
  return `Anchor is ${pageUrl === '' ? 'a tab with no URL yet' : 'about:blank'}, not ${bootUrl} — `
    + 'the page has not committed, so DOM counts here are 0 for that reason, not the page\'s. '
    + `Re-run in a moment, or \`tirno nav ${bootUrl}\` to force it.`;
}

/**
 * A tab's handle, short enough to type: the first 8 hex of CDP's targetId.
 *
 * The position in `browser.pages()` is NOT a handle. `tirno pages` and
 * `tirno close-tab` are separate processes, so anything that opens or closes a
 * tab in between renumbers every row — and the number the user typed then means
 * a different tab. Chrome puts a new tab at index 0, so this is the common case,
 * not a corner: it closed the wrong tab during a smoke run. targetId does not
 * move for the life of the tab.
 */
export async function pageHandle(page: Page): Promise<string> {
  const cdp = await page.createCDPSession();
  try {
    const { targetInfo } = await cdp.send('Target.getTargetInfo') as { targetInfo: { targetId: string } };
    return targetInfo.targetId.slice(0, 8).toLowerCase();
  } finally {
    await cdp.detach();
  }
}

export interface PageEntry {
  /** stable handle — see pageHandle */
  id: string;
  url: string;
  title: string;
}

export async function listPages(browser: Browser): Promise<PageEntry[]> {
  const pages = await browser.pages();
  const result: PageEntry[] = [];
  for (const page of pages) {
    result.push({
      id: await pageHandle(page),
      url: page.url(),
      title: await page.title(),
    });
  }
  return result;
}

/**
 * Resolve a handle to its tab. A prefix is enough as long as it picks out one
 * tab; an ambiguous or unknown handle is an error rather than a guess, because
 * the callers close and switch tabs.
 */
export async function getPageByHandle(browser: Browser, handle: string): Promise<Page> {
  const wanted = handle.trim().toLowerCase();
  if (!wanted) throw new Error('Empty page id — run `tirno pages` for the list');

  // Four characters minimum. A handle is hex, so an all-digit prefix like
  // '0176' is perfectly valid and must not be mistaken for an index — but a
  // bare '0' or '2' is almost certainly someone (or some old script) still
  // passing a position, and matching that as a prefix would close whichever tab
  // happened to start with that digit.
  if (wanted.length < 4) {
    throw new Error(
      /^\d+$/.test(wanted)
        ? `'${handle}' looks like a positional index. Page ids are stable handles now — run \`tirno pages\` and use the ID column.`
        : `Page id '${handle}' is too short — give at least 4 characters from \`tirno pages\`.`
    );
  }

  const pages = await browser.pages();
  const matches: Page[] = [];
  for (const page of pages) {
    if ((await pageHandle(page)).startsWith(wanted)) matches.push(page);
  }

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No page with id '${handle}' (${pages.length} open) — run \`tirno pages\``);
  throw new Error(`Page id '${handle}' matches ${matches.length} tabs — use more characters`);
}
