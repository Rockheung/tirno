import { Command } from 'commander';
import { intArg, floatArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import * as recStore from '../core/record-store.js';
import { success, info, error } from '../output/formatter.js';

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

export function registerReplayCommand(program: Command): void {
  program
    .command('replay <name>')
    .description('Replay a recorded session via raw CDP (trusted events)')
    .option('-s, --session <name>', 'Session name')
    .option('--speed <n>', 'Playback speed multiplier (default 1.0)', floatArg, 1.0)
    .option('--max-gap <ms>', 'Cap inter-event delay (default 500ms)', intArg, 500)
    .option('--no-nav', 'Skip navigating to startUrl first')
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const send = cdp.send.bind(cdp) as any;

        const speed = Math.max(0.01, opts.speed);
        const maxGap = opts.maxGap;
        let lastT = 0;
        let count = 0;

        for (const ev of rec.events) {
          const gap = Math.min(maxGap, Math.max(0, (ev.t - lastT) / speed));
          if (gap > 0) await new Promise(r => setTimeout(r, gap));
          lastT = ev.t;

          if (ev.type === 'click' && typeof ev.x === 'number' && typeof ev.y === 'number') {
            await dispatchClick(send, ev.x, ev.y);
            count++;
          } else if (ev.type === 'keydown' && ev.key) {
            await dispatchKey(send, ev.key);
            count++;
          } else if (ev.type === 'input' && ev.sel && ev.value !== undefined && ev.value !== null) {
            // input is best-replayed via setting value on the selector; click fallback if missing
            await page.evaluate((sel: string, v: string) => {
              const el = document.querySelector(sel) as HTMLInputElement | null;
              if (el) {
                el.value = v;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, ev.sel, ev.value).catch(() => {});
            count++;
          } else if (ev.type === 'scroll' && typeof ev.y === 'number') {
            await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior }), ev.y);
            count++;
          }
        }

        await cdp.detach();
        browser.disconnect();
        success(`Replayed "${name}" — ${count}/${rec.events.length} events at ${speed}x`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dispatchClick(send: any, x: number, y: number): Promise<void> {
  const moved: DispatchMouseParams = { type: 'mouseMoved', x, y };
  const pressed: DispatchMouseParams = { type: 'mousePressed', x, y, button: 'left', clickCount: 1 };
  const released: DispatchMouseParams = { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', moved);
  await send('Input.dispatchMouseEvent', pressed);
  await send('Input.dispatchMouseEvent', released);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dispatchKey(send: any, key: string): Promise<void> {
  const isPrintable = key.length === 1;
  const down: DispatchKeyParams = isPrintable
    ? { type: 'keyDown', key, text: key }
    : { type: 'keyDown', key };
  await send('Input.dispatchKeyEvent', down);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
}
