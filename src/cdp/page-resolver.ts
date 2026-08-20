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

export async function getPageById(browser: Browser, pageId: number): Promise<Page> {
  const pages = await browser.pages();
  if (pageId < 0 || pageId >= pages.length) {
    throw new Error(`Page ${pageId} not found (${pages.length} pages)`);
  }
  return pages[pageId];
}

export async function listPages(browser: Browser): Promise<Array<{ id: number; url: string; title: string }>> {
  const pages = await browser.pages();
  const result = [];
  for (let i = 0; i < pages.length; i++) {
    result.push({
      id: i,
      url: pages[i].url(),
      title: await pages[i].title(),
    });
  }
  return result;
}
