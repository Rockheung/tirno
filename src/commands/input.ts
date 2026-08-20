import { Command } from 'commander';
import { intArg, floatArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, error } from '../output/formatter.js';
import { clickByRef, fillByRef } from '../cdp/dom-actions.js';
import * as refStore from '../core/ref-store.js';
import type { Page } from 'puppeteer-core';

async function elemCenter(page: Page, selector: string): Promise<[number, number]> {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }, selector);
  if (!box) throw new Error(`Element not found: ${selector}`);
  return [Math.round(box[0]), Math.round(box[1])];
}

export function registerInputCommands(program: Command): void {
  program
    .command('click')
    .description('Click by CSS selector, @ref, or "x,y" coordinates')
    .argument('<target>', 'CSS selector, @N ref, or "<x>,<y>" coordinates')
    .option('-s, --session <name>', 'Session name')
    .option('--dbl', 'Double click')
    .action(async (target: string, opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);

        // "x,y" coordinate form — dispatch raw CDP mouse events (trusted click).
        const coordMatch = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(target);
        if (coordMatch) {
          const x = Number(coordMatch[1]);
          const y = Number(coordMatch[2]);
          const cdp = await page.createCDPSession();
          try {
            const clickCount = opts.dbl ? 2 : 1;
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
            if (opts.dbl) {
              await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
              await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
            }
          } finally {
            await cdp.detach();
          }
          browser.disconnect();
          success(`Clicked (${x},${y})${opts.dbl ? ' (dbl)' : ''}`);
          return;
        }

        if (refStore.isRef(target)) {
          const backendId = refStore.resolveRef(meta.name, target);
          await clickByRef(page, backendId, opts.dbl);
        } else if (opts.dbl) {
          await page.click(target, { count: 2 });
        } else {
          await page.click(target);
        }

        browser.disconnect();
        success(`Clicked ${target}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('fill')
    .description('Clear and type into an input element by selector or @ref')
    .argument('[target]', 'CSS selector or @N ref from snapshot (omit when --batch)')
    .argument('[value]', 'Value to fill (omit when --batch)')
    .option('-s, --session <name>', 'Session name')
    .option('--batch <json>', 'Fill multiple fields in one call. JSON array: [{"target":"#a","value":"x"},...]')
    .action(async (target: string | undefined, value: string | undefined, opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);

        if (opts.batch) {
          let entries: Array<{ target: string; value: string }>;
          try {
            const parsed = JSON.parse(opts.batch);
            if (!Array.isArray(parsed)) throw new Error('expected array');
            entries = parsed;
          } catch (e) {
            throw new Error(`--batch invalid JSON: ${(e as Error).message}`);
          }
          for (const entry of entries) {
            if (!entry.target || typeof entry.value !== 'string') {
              throw new Error(`--batch entries need {target, value}`);
            }
            if (refStore.isRef(entry.target)) {
              const backendId = refStore.resolveRef(meta.name, entry.target);
              await fillByRef(page, backendId, entry.value);
            } else {
              await page.click(entry.target, { count: 3 });
              await page.type(entry.target, entry.value);
            }
          }
          browser.disconnect();
          success(`Filled ${entries.length} field${entries.length === 1 ? '' : 's'}`);
          return;
        }

        if (!target || value === undefined) {
          throw new Error('Provide <target> <value> or --batch <json>');
        }

        if (refStore.isRef(target)) {
          const backendId = refStore.resolveRef(meta.name, target);
          await fillByRef(page, backendId, value);
        } else {
          // triple-click to select all, then type to replace
          await page.click(target, { count: 3 });
          await page.type(target, value);
        }

        browser.disconnect();
        success(`Filled ${target} with "${value}"`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('type')
    .description('Type text (keyboard input)')
    .argument('<text>', 'Text to type')
    .option('-s, --session <name>', 'Session name')
    .option('--delay <ms>', 'Delay between keystrokes', intArg, 0)
    .action(async (text: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        await page.keyboard.type(text, { delay: opts.delay });

        browser.disconnect();
        success(`Typed "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('press')
    .description('Press a key')
    .argument('<key>', 'Key name (Enter, Tab, Escape, ArrowDown, ...)')
    .option('-s, --session <name>', 'Session name')
    .action(async (key: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        await page.keyboard.press(key as import('puppeteer-core').KeyInput);

        browser.disconnect();
        success(`Pressed ${key}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('hover')
    .description('Hover over an element')
    .argument('<selector>', 'CSS selector')
    .option('-s, --session <name>', 'Session name')
    .action(async (selector: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        await page.hover(selector);

        browser.disconnect();
        success(`Hovered ${selector}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('drag')
    .description('Drag from <from> to <to>. Coords as "x,y" or selectors (auto-detect).')
    .argument('<from>', 'Source: "x,y" coord or CSS selector')
    .argument('<to>', 'Destination: "x,y" coord or CSS selector')
    .option('-s, --session <name>', 'Session name')
    .option('--steps <n>', 'Intermediate mousemove steps (default 20)', intArg, 20)
    .option('--hold <ms>', 'Hold time at source after mousedown (default 100)', intArg, 100)
    .option('--native', 'Force native HTML5 drag intercept even with coord args')
    .action(async (from: string, to: string, opts) => {
      try {
        const isCoord = (s: string) => /^\d+\s*,\s*\d+$/.test(s);
        const parseCoord = (s: string): [number, number] => {
          const [x, y] = s.split(',').map(n => parseInt(n.trim(), 10));
          return [x, y];
        };

        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        // native HTML5 drag intercept path (selector OR coord — drag with
        // CDP intercept gives the page the trusted dataTransfer it needs)
        if (!isCoord(from) && !isCoord(to) || opts.native) {
          const [fx, fy] = isCoord(from) ? parseCoord(from) : await elemCenter(page, from);
          const [tx, ty] = isCoord(to) ? parseCoord(to) : await elemCenter(page, to);
          const cdp = await page.createCDPSession();
          let dragData: unknown = null;
          cdp.on('Input.dragIntercepted', (e: unknown) => { dragData = (e as { data: unknown }).data; });
          await cdp.send('Input.setInterceptDrags', { enabled: true });
          await page.mouse.move(fx, fy);
          await page.mouse.down();
          // small move to trigger dragstart → dragIntercepted
          await page.mouse.move(fx + 5, fy + 5);
          await page.mouse.move(tx, ty, { steps: opts.steps });
          // wait for intercept to capture data
          await new Promise(r => setTimeout(r, 150));
          if (dragData) {
             
            const data = dragData as any;
             
            const sendAny = cdp.send.bind(cdp) as any;
            await sendAny('Input.dispatchDragEvent', { type: 'dragEnter', x: tx, y: ty, data });
            await sendAny('Input.dispatchDragEvent', { type: 'dragOver', x: tx, y: ty, data });
            await sendAny('Input.dispatchDragEvent', { type: 'drop', x: tx, y: ty, data });
          }
          await page.mouse.up();
          await cdp.send('Input.setInterceptDrags', { enabled: false });
          await cdp.detach();
          browser.disconnect();
          success(`Dragged "${from}" (${fx},${fy}) → "${to}" (${tx},${ty}) ${dragData ? '[native drag]' : '[no drag data — mouse only]'}`);
          return;
        }

        // coord-based fallback (mouse events only — no native drag)
        const [fx, fy] = isCoord(from) ? parseCoord(from) : await elemCenter(page, from);
        const [tx, ty] = isCoord(to) ? parseCoord(to) : await elemCenter(page, to);
        await page.mouse.move(fx, fy);
        await page.mouse.down();
        await new Promise(r => setTimeout(r, opts.hold));
        await page.mouse.move(tx, ty, { steps: opts.steps });
        await page.mouse.up();

        browser.disconnect();
        success(`Dragged (${fx},${fy}) → (${tx},${ty}) (mouse only)`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('scroll')
    .description('Scroll the page (up|down|<pixels>)')
    .argument('<direction>', 'up | down | a positive/negative pixel amount')
    .option('-s, --session <name>', 'Session name')
    .option('--step <px>', 'Pixels per up/down (default 600)', intArg, 600)
    .action(async (direction: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        let dy: number;
        if (direction === 'up') dy = -opts.step;
        else if (direction === 'down') dy = opts.step;
        else {
          const n = Number(direction);
          if (Number.isNaN(n)) throw new Error(`Invalid direction: ${direction}. Use up | down | <pixels>`);
          dy = n;
        }

        await page.evaluate((y: number) => window.scrollBy({ top: y, behavior: 'instant' as ScrollBehavior }), dy);

        browser.disconnect();
        success(`Scrolled ${dy > 0 ? '+' : ''}${dy}px`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('wait')
    .description('Sleep for milliseconds')
    .argument('<ms>', 'Milliseconds to wait', intArg)
    .action(async (ms: number) => {
      try {
        if (!Number.isFinite(ms) || ms < 0) throw new Error('Milliseconds must be a non-negative integer');
        await new Promise(r => setTimeout(r, ms));
        success(`Waited ${ms}ms`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('wait-for')
    .description('Wait for a selector, text, or network idle')
    .argument('[selector]', 'CSS selector to wait for')
    .option('-s, --session <name>', 'Session name')
    .option('--text <text>', 'Wait until any of the given texts appears in document.body.innerText (comma-separated for any-of)')
    .option('--network-idle', 'Wait for network idle instead of a selector')
    .option('--timeout <ms>', 'Max wait time', intArg, 30000)
    .action(async (selector: string | undefined, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        if (opts.networkIdle) {
          await page.waitForNetworkIdle({ timeout: opts.timeout });
          browser.disconnect();
          success('Network idle');
          return;
        }
        if (opts.text) {
          const needles = opts.text.split(',').map((s: string) => s.trim()).filter(Boolean);
          if (needles.length === 0) throw new Error('--text needs at least one non-empty string');
          await page.waitForFunction(
            (texts: string[]) => {
              const body = document.body?.innerText ?? '';
              return texts.some(t => body.includes(t));
            },
            { timeout: opts.timeout, polling: 200 },
            needles,
          );
          browser.disconnect();
          success(`Text visible: ${needles.join(' | ')}`);
          return;
        }
        if (!selector) throw new Error('Provide a selector, --text, or --network-idle');
        await page.waitForSelector(selector, { timeout: opts.timeout });
        browser.disconnect();
        success(`Selector visible: ${selector}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('upload')
    .description('Upload files to a file input')
    .argument('<selector>', 'CSS selector for file input')
    .argument('<files...>', 'File paths to upload')
    .option('-s, --session <name>', 'Session name')
    .action(async (selector: string, files: string[], opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const input = await page.$(selector);
        if (!input) throw new Error(`Element not found: ${selector}`);

        await (input as import('puppeteer-core').ElementHandle<HTMLInputElement>).uploadFile(...files);

        browser.disconnect();
        success(`Uploaded ${files.length} file(s) to ${selector}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
