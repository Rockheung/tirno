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
