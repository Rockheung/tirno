import { connect } from './chrome-connector.js';
import { openFirefoxPage } from './firefox.js';
import * as store from './session-store.js';
import { getActivePage } from '../cdp/page-resolver.js';
import type { ScreenshotOptions } from '../cdp/page.js';

/** 엔진이 달라도 같은 뜻으로 동작하는 페이지 조작. Firefox 세션은 이것만 된다. */
export interface EnginePage {
  url(): string;
  goto(url: string, opts?: { timeout?: number; waitUntil?: 'domcontentloaded' }): Promise<{ status(): number } | null>;
  evaluate(fn: string | ((...args: never[]) => unknown), ...args: unknown[]): Promise<unknown>;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
}

export async function openPage(session?: string): Promise<{ page: EnginePage; browser: { disconnect(): void }; meta: store.SessionMetadata }> {
  const name = session ?? store.getActive();
  const firefox = name ? store.get(name) : null;
  if (firefox?.engine === 'firefox') return { ...await openFirefoxPage(firefox), meta: firefox };
  const { browser, meta } = await connect(session);
  return { page: await getActivePage(browser), browser, meta };
}
