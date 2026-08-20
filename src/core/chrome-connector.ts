import puppeteer, { type Browser } from 'puppeteer-core';
import * as store from './session-store.js';
import { inspectSession } from './inventory.js';
import { ChromeNotRunning, NoActiveSession, SessionNotOwned } from '../util/errors.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { applyEmulation } from '../cdp/emulation.js';

/**
 * Attach to a session's browser and prepare its pages (dialog auto-dismiss,
 * unload neutralisation, the recorder, stored emulation).
 *
 * That preparation runs code *in the renderer*, which is fine everywhere except
 * when the renderer is the thing under investigation: on a page whose main
 * thread is pinned, the injection queues behind it and the command does not
 * return until the page frees up. Use connectWithoutPageSetup for anything that
 * has to keep working while a page is wedged.
 */
export async function connect(sessionName?: string): Promise<{ browser: Browser; meta: store.SessionMetadata }> {
  return connectSession(sessionName, true);
}

/**
 * Same ownership checks and the same browser, but nothing is evaluated in the
 * page. Diagnostics use this: measuring a stalled renderer must not begin by
 * waiting on that renderer.
 */
export async function connectWithoutPageSetup(sessionName?: string): Promise<{ browser: Browser; meta: store.SessionMetadata }> {
  return connectSession(sessionName, false);
}

async function connectSession(sessionName: string | undefined, prepare: boolean): Promise<{ browser: Browser; meta: store.SessionMetadata }> {
  const name = sessionName ?? store.getActive();
  if (!name) throw new NoActiveSession();

  const meta = store.get(name);

  // `isAlive(pid)` alone is not enough here: pids are recycled and ports are
  // inherited. Require pid + port + profile to agree before handing CDP control
  // to whatever answers on that port.
  const inv = await inspectSession(meta);
  if (inv.ownership === 'ghost') throw new ChromeNotRunning(name, meta.pid);
  if (inv.ownership !== 'ours') throw new SessionNotOwned(name, inv.resolvedPort, inv.reason);

  // inspectSession already resolved DevToolsActivePort (live) over
  // meta.wsEndpoint (a launch-time snapshot that goes stale on restart);
  // legacy fixed-port sessions write no such file and fall back to meta.
  const browser = await puppeteer.connect({
    browserWSEndpoint: inv.wsEndpoint,
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

  // Recording listener — captures user input events into window.__tirno_rec
  // and persists to localStorage so page reload / SPA route changes survive.
  // Inactive by default; tirno record start/stop toggles via __tirno_rec.recording.
  //
  // Persistence model:
  // - localStorage key '__tirno_rec_state' holds { recording, startTs, events }
  // - on inject (each new document) we restore from localStorage if present
  // - every event push schedules a debounced flush (200ms or on pagehide)
  // - record start clears events; record stop reads then clears
  //
  // Limits:
  // - localStorage is per-origin; cross-origin nav loses its in-flight buffer
  //   for that origin. record stop currently reads only the active page's
  //   localStorage. Daemon mode (separate task) is the long-term fix.
  const RECORD_INSTALL = `
    if (!window.__tirno_rec) {
      const STORAGE_KEY = '__tirno_rec_state';
      let restored = null;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) restored = JSON.parse(raw);
      } catch (_) { /* localStorage may be blocked (e.g. file://) */ }

      const bestSelector = (el) => {
        if (!el || el.nodeType !== 1) return null;
        if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
        const testid = el.getAttribute && el.getAttribute('data-testid');
        if (testid) return '[data-testid=' + JSON.stringify(testid) + ']';
        const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
        if (ariaLabel) return '[aria-label=' + JSON.stringify(ariaLabel) + ']';
        const name = el.getAttribute && el.getAttribute('name');
        if (name && el.tagName) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
        return null;
      };

      const rec = window.__tirno_rec = {
        events: (restored && Array.isArray(restored.events)) ? restored.events : [],
        recording: !!(restored && restored.recording),
        startTs: (restored && typeof restored.startTs === 'number') ? restored.startTs : 0,
      };

      let flushTimer = null;
      const flushNow = () => {
        flushTimer = null;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            recording: rec.recording,
            startTs: rec.startTs,
            events: rec.events,
          }));
        } catch (_) { /* quota / blocked */ }
      };
      const scheduleFlush = () => {
        if (flushTimer != null) return;
        flushTimer = setTimeout(flushNow, 200);
      };
      window.__tirno_rec_flush = flushNow;

      const a11yRoleOf = (el) => {
        if (!el || el.nodeType !== 1) return undefined;
        const explicit = el.getAttribute && el.getAttribute('role');
        if (explicit) return explicit;
        // implicit role from tagName for common interactives
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        if (tag === 'a' && el.hasAttribute && el.hasAttribute('href')) return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'input') {
          const t = el.getAttribute('type') || 'text';
          return t === 'submit' || t === 'button' ? 'button' : 'textbox';
        }
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        return tag || undefined;
      };
      const a11yNameOf = (el) => {
        if (!el || el.nodeType !== 1) return undefined;
        const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const lbl = document.getElementById(labelledBy);
          if (lbl) return (lbl.textContent || '').trim().slice(0, 80);
        }
        const alt = el.getAttribute && el.getAttribute('alt');
        if (alt) return alt;
        const title = el.getAttribute && el.getAttribute('title');
        if (title) return title;
        // visible text fallback (truncated)
        const txt = (el.textContent || '').trim();
        if (txt) return txt.slice(0, 80);
        return undefined;
      };

      const log = (type, e) => {
        if (!rec.recording) return;
        const t = e.target;
        const r = t && t.getBoundingClientRect ? t.getBoundingClientRect() : null;
        const sel = bestSelector(t);
        const role = a11yRoleOf(t);
        const name = a11yNameOf(t);
        const bbox = r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;

        const channels = {};
        if (role || name) channels.a11y = { role, name };
        if (sel || (t && t.tagName)) channels.dom = { selector: sel || undefined, tagName: t && t.tagName };
        if (bbox) channels.visual = { bbox };

        rec.events.push({
          type,
          t: Date.now() - rec.startTs,
          x: e.clientX, y: e.clientY,
          key: e.key,
          value: e.target && (e.target.value !== undefined ? e.target.value : null),
          channels,
          // legacy flat fields kept for downgrade tools
          sel,
          tag: t && t.tagName,
          bbox,
        });
        scheduleFlush();
      };

      addEventListener('click', e => log('click', e), { capture: true, passive: true });
      addEventListener('keydown', e => log('keydown', e), { capture: true, passive: true });
      addEventListener('input', e => log('input', e), { capture: true, passive: true });
      addEventListener('scroll', () => log('scroll', { clientX: 0, clientY: 0, target: document.scrollingElement }), { capture: true, passive: true });

      // best-effort flush before page tears down. (beforeunload is filtered by
      // NEUTRALIZE_UNLOAD; pagehide + visibilitychange cover SPA + reload + tab close.)
      addEventListener('pagehide', flushNow, { capture: true });
      addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushNow();
      }, { capture: true });
    }
  `;

  const attachToPage = async (p: import('puppeteer-core').Page): Promise<void> => {
    try {
      p.removeAllListeners('dialog');
      p.on('dialog', (d) => { d.accept().catch(() => {}); });
      await p.evaluateOnNewDocument(NEUTRALIZE_UNLOAD);
      await p.evaluateOnNewDocument(RECORD_INSTALL);
      // also patch the *current* document — evaluateOnNewDocument only takes
      // effect on next navigation; current page may have already attached
      await p.evaluate(NEUTRALIZE_UNLOAD).catch(() => {});
      await p.evaluate(RECORD_INSTALL).catch(() => {});
    } catch { /* page may be detached; best-effort */ }
  };
  const attachAll = async (): Promise<void> => {
    try {
      for (const p of await browser.pages()) await attachToPage(p);
    } catch { /* best-effort */ }
  };
  if (prepare) {
    await attachAll();
    browser.on('targetcreated', () => { attachAll().catch(() => {}); });
  }

  if (prepare && meta.emulation) {
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
