import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, error } from '../output/formatter.js';
import { clickByRef, fillByRef } from '../cdp/dom-actions.js';
import * as refStore from '../core/ref-store.js';

export function registerInputCommands(program: Command): void {
  program
    .command('click')
    .description('Click an element by CSS selector or @ref')
    .argument('<target>', 'CSS selector or @N ref from snapshot')
    .option('-s, --session <name>', 'Session name')
    .option('--dbl', 'Double click')
    .action(async (target: string, opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);

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
    .argument('<target>', 'CSS selector or @N ref from snapshot')
    .argument('<value>', 'Value to fill')
    .option('-s, --session <name>', 'Session name')
    .action(async (target: string, value: string, opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);

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
    .option('--delay <ms>', 'Delay between keystrokes', parseInt, 0)
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
    .command('scroll')
    .description('Scroll the page (up|down|<pixels>)')
    .argument('<direction>', 'up | down | a positive/negative pixel amount')
    .option('-s, --session <name>', 'Session name')
    .option('--step <px>', 'Pixels per up/down (default 600)', parseInt, 600)
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
    .argument('<ms>', 'Milliseconds to wait', (v) => parseInt(v, 10))
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
    .description('Wait for a selector to appear or for network idle')
    .argument('[selector]', 'CSS selector to wait for')
    .option('-s, --session <name>', 'Session name')
    .option('--network-idle', 'Wait for network idle instead of a selector')
    .option('--timeout <ms>', 'Max wait time', (v) => parseInt(v, 10), 30000)
    .action(async (selector: string | undefined, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        if (opts.networkIdle) {
          await page.waitForNetworkIdle({ timeout: opts.timeout });
          browser.disconnect();
          success('Network idle');
        } else {
          if (!selector) throw new Error('Provide a selector or use --network-idle');
          await page.waitForSelector(selector, { timeout: opts.timeout });
          browser.disconnect();
          success(`Selector visible: ${selector}`);
        }
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
