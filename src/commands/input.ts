import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, error } from '../output/formatter.js';

export function registerInputCommands(program: Command): void {
  program
    .command('click')
    .description('Click an element by CSS selector')
    .argument('<selector>', 'CSS selector')
    .option('-s, --session <name>', 'Session name')
    .option('--dbl', 'Double click')
    .action(async (selector: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        if (opts.dbl) {
          await page.click(selector, { count: 2 });
        } else {
          await page.click(selector);
        }

        browser.disconnect();
        success(`Clicked ${selector}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('fill')
    .description('Clear and type into an input element')
    .argument('<selector>', 'CSS selector')
    .argument('<value>', 'Value to fill')
    .option('-s, --session <name>', 'Session name')
    .action(async (selector: string, value: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        // triple-click to select all, then type to replace
        await page.click(selector, { count: 3 });
        await page.type(selector, value);

        browser.disconnect();
        success(`Filled ${selector} with "${value}"`);
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
