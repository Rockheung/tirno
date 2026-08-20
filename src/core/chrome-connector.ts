import puppeteer, { type Browser } from 'puppeteer-core';
import * as store from './session-store.js';
import { isAlive } from './process-guard.js';
import { ChromeNotRunning, NoActiveSession } from '../util/errors.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { applyEmulation } from '../cdp/emulation.js';

export async function connect(sessionName?: string): Promise<{ browser: Browser; meta: store.SessionMetadata }> {
  const name = sessionName ?? store.getActive();
  if (!name) throw new NoActiveSession();

  const meta = store.get(name);

  if (!isAlive(meta.pid)) {
    throw new ChromeNotRunning(name, meta.pid);
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: meta.wsEndpoint,
    defaultViewport: null,
  });

  // Auto-dismiss any JS dialog (alert/confirm/prompt) and neutralize
  // beforeunload handlers on every page so navigation/clicks don't silently
  // hang. Without this, sites that raise onbeforeunload — common in
  // design/edit modes — block tirno commands.
  //
  // Two-layer defense:
  // 1. dialog event listener — accepts any dialog that does open
  // 2. evaluateOnNewDocument — neutralizes onbeforeunload before page JS runs
  //    AND filters addEventListener('beforeunload') so listener never fires.
  const NEUTRALIZE_UNLOAD = `
    try {
      Object.defineProperty(window, 'onbeforeunload', {
        get: () => null,
        set: () => true,
        configurable: false,
      });
    } catch (_) { window.onbeforeunload = null; }
    const _add = window.addEventListener;
    window.addEventListener = function (type, listener, opts) {
      if (type === 'beforeunload') return;
      return _add.call(this, type, listener, opts);
    };
  `;

  const attachToPage = async (p: import('puppeteer-core').Page): Promise<void> => {
    try {
      p.removeAllListeners('dialog');
      p.on('dialog', (d) => { d.accept().catch(() => {}); });
      await p.evaluateOnNewDocument(NEUTRALIZE_UNLOAD);
      // also patch the *current* document — evaluateOnNewDocument only takes
      // effect on next navigation; current page may have already attached
      await p.evaluate(NEUTRALIZE_UNLOAD).catch(() => {});
    } catch { /* page may be detached; best-effort */ }
  };
  const attachAll = async (): Promise<void> => {
    try {
      for (const p of await browser.pages()) await attachToPage(p);
    } catch { /* best-effort */ }
  };
  await attachAll();
  browser.on('targetcreated', () => { attachAll().catch(() => {}); });

  if (meta.emulation) {
    try {
      const page = await getActivePage(browser);
      await applyEmulation(page, meta.emulation);
    } catch {
      // page resolution can fail on edge cases (no pages); ignore — caller will surface real errors
    }
  }

  store.update(name, { lastAccessedAt: new Date().toISOString() });

  return { browser, meta };
}
