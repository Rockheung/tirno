import { Command } from 'commander';
import { intArg, floatArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import * as recStore from '../core/record-store.js';
import { success, info, error } from '../output/formatter.js';
import type { Page } from 'puppeteer-core';

interface DispatchMouseParams {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
  x: number;
  y: number;
  button?: 'none' | 'left' | 'middle' | 'right';
  clickCount?: number;
}

interface DispatchKeyParams {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
  key?: string;
  text?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
}

interface ResolvedTarget {
  x: number;
  y: number;
  channel: 'dom' | 'a11y' | 'visual.bbox' | 'event.xy';
}

// Multi-channel fallback: find the click target on the live page, in order of
// most-stable channel first. Returns x,y to dispatch the trusted CDP click.
async function resolveTarget(page: Page, ev: recStore.RecordedEvent): Promise<ResolvedTarget | null> {
  const ch = ev.channels ?? {};

  // 1. dom.selector — fastest and most precise
  const sel = ch.dom?.selector ?? ev.sel ?? null;
  if (sel) {
    const xy = await page.evaluate((s: string) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    }, sel).catch(() => null);
    if (xy) return { x: xy[0], y: xy[1], channel: 'dom' };
  }

  // 2. a11y role + name — search live DOM for an element matching role+name
  const role = ch.a11y?.role;
  const name = ch.a11y?.name;
  if (role && name) {
    const xy = await page.evaluate(({ r, n }: { r: string; n: string }) => {
      const candidates = Array.from(document.querySelectorAll('*'));
      for (const el of candidates) {
        const elRole = el.getAttribute('role') ||
          (el.tagName === 'A' && el.hasAttribute('href') ? 'link' :
           el.tagName === 'BUTTON' ? 'button' :
           el.tagName === 'INPUT' ? (el.getAttribute('type') === 'submit' || el.getAttribute('type') === 'button' ? 'button' : 'textbox') :
           el.tagName === 'TEXTAREA' ? 'textbox' :
           el.tagName === 'SELECT' ? 'combobox' :
           el.tagName.toLowerCase());
        if (elRole !== r) continue;
        const elName = el.getAttribute('aria-label') ||
                       el.getAttribute('alt') ||
                       el.getAttribute('title') ||
                       (el.textContent || '').trim().slice(0, 80);
        if (elName !== n) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        return [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)];
      }
      return null;
    }, { r: role, n: name }).catch(() => null);
    if (xy) return { x: xy[0], y: xy[1], channel: 'a11y' };
  }

  // 3. visual.bbox — verify an element is still at the recorded center
  const bbox = ch.visual?.bbox ?? ev.bbox ?? null;
  if (bbox) {
    const cx = Math.round(bbox.x + bbox.w / 2);
    const cy = Math.round(bbox.y + bbox.h / 2);
    const ok = await page.evaluate(({ x, y }: { x: number; y: number }) => {
      const el = document.elementFromPoint(x, y);
      return !!el;
    }, { x: cx, y: cy }).catch(() => false);
    if (ok) return { x: cx, y: cy, channel: 'visual.bbox' };
  }

  // 4. event.xy fallback — record-time click coords (often equal to bbox center)
  if (typeof ev.x === 'number' && typeof ev.y === 'number') {
    return { x: ev.x, y: ev.y, channel: 'event.xy' };
  }

  return null;
}

export function registerReplayCommand(program: Command): void {
  program
    .command('replay <name>')
    .description('Replay a recorded session via raw CDP (trusted events). Multi-channel fallback: dom → a11y → bbox → event.xy.')
    .option('-s, --session <name>', 'Session name')
    .option('--speed <n>', 'Playback speed multiplier (default 1.0)', floatArg, 1.0)
    .option('--max-gap <ms>', 'Cap inter-event delay (default 500ms)', intArg, 500)
    .option('--no-nav', 'Skip navigating to startUrl first')
    .option('--verbose', 'Print which channel matched per event')
    .action(async (name: string, opts) => {
      try {
        const rec = recStore.load(name);
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        if (opts.nav !== false && page.url() !== rec.startUrl) {
          info(`Navigating to ${rec.startUrl}`);
          await page.goto(rec.startUrl, { waitUntil: 'domcontentloaded' });
        }

        const cdp = await page.createCDPSession();
        const send = cdp.send.bind(cdp) as any;

        const speed = Math.max(0.01, opts.speed);
        const maxGap = opts.maxGap;
        let lastT = 0;
        let count = 0;
        const channelStats: Record<string, number> = {};

        for (const ev of rec.events) {
          const gap = Math.min(maxGap, Math.max(0, (ev.t - lastT) / speed));
          if (gap > 0) await new Promise(r => setTimeout(r, gap));
          lastT = ev.t;

          if (ev.type === 'click') {
            const target = await resolveTarget(page, ev);
            if (target) {
              await dispatchClick(send, target.x, target.y);
              channelStats[target.channel] = (channelStats[target.channel] ?? 0) + 1;
              if (opts.verbose) info(`+${ev.t}ms click via ${target.channel} → (${target.x},${target.y})`);
              count++;
            } else {
              if (opts.verbose) info(`+${ev.t}ms click skipped — no channel resolvable`);
            }
          } else if (ev.type === 'keydown' && ev.key) {
            await dispatchKey(send, ev.key);
            count++;
          } else if (ev.type === 'input' && ev.value !== undefined && ev.value !== null) {
            const sel = ev.channels?.dom?.selector ?? ev.sel;
            if (sel) {
              await page.evaluate((s: string, v: string) => {
                const el = document.querySelector(s) as HTMLInputElement | null;
                if (el) {
                  el.value = v;
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, sel, ev.value).catch(() => {});
              count++;
            }
          } else if (ev.type === 'scroll' && typeof ev.y === 'number') {
            await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior }), ev.y);
            count++;
          }
        }

        await cdp.detach();
        browser.disconnect();
        const channelSummary = Object.entries(channelStats)
          .map(([k, v]) => `${k}:${v}`).join(' ');
        success(`Replayed "${name}" — ${count}/${rec.events.length} events at ${speed}x${channelSummary ? ` [${channelSummary}]` : ''}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}

async function dispatchClick(send: any, x: number, y: number): Promise<void> {
  const moved: DispatchMouseParams = { type: 'mouseMoved', x, y };
  const pressed: DispatchMouseParams = { type: 'mousePressed', x, y, button: 'left', clickCount: 1 };
  const released: DispatchMouseParams = { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', moved);
  await send('Input.dispatchMouseEvent', pressed);
  await send('Input.dispatchMouseEvent', released);
}

async function dispatchKey(send: any, key: string): Promise<void> {
  const isPrintable = key.length === 1;
  const down: DispatchKeyParams = isPrintable
    ? { type: 'keyDown', key, text: key }
    : { type: 'keyDown', key };
  await send('Input.dispatchKeyEvent', down);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
}
