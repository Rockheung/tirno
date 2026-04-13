import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage, listPages } from '../cdp/page-resolver.js';
import { formatTable, success, info, error } from '../output/formatter.js';

export function registerNavCommands(program: Command): void {
  program
    .command('nav')
    .description('Navigate to a URL')
    .argument('<url>', 'Target URL')
    .option('-s, --session <name>', 'Session name')
    .option('--timeout <ms>', 'Navigation timeout', parseInt, 30000)
    .action(async (url: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const start = Date.now();
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: opts.timeout,
        });
        const elapsed = Date.now() - start;
        const status = response?.status() ?? 0;
        browser.disconnect();
        success(`${url} (${status}, ${elapsed}ms)`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('reload')
    .description('Reload current page')
    .option('-s, --session <name>', 'Session name')
    .option('--hard', 'Ignore cache')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        await page.reload({ waitUntil: 'domcontentloaded' });
        browser.disconnect();
        success(`Reloaded ${page.url()}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('back')
    .description('Go back in history')
    .option('-s, --session <name>', 'Session name')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        await page.goBack({ waitUntil: 'domcontentloaded' });
        browser.disconnect();
        success(`Back → ${page.url()}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('forward')
    .description('Go forward in history')
    .option('-s, --session <name>', 'Session name')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        await page.goForward({ waitUntil: 'domcontentloaded' });
        browser.disconnect();
        success(`Forward → ${page.url()}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('pages')
    .description('List open pages/tabs')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const pages = await listPages(browser);
        browser.disconnect();

        if (opts.json) {
          console.log(JSON.stringify(pages, null, 2));
          return;
        }

        const rows = pages.map(p => [
          String(p.id),
          p.title.slice(0, 40) || '(untitled)',
          p.url.slice(0, 80),
        ]);
        console.log(formatTable(['ID', 'TITLE', 'URL'], rows));
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('select')
    .description('Select a page/tab by ID')
    .argument('<pageId>', 'Page ID', parseInt)
    .option('-s, --session <name>', 'Session name')
    .action(async (pageId: number, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const pages = await browser.pages();
        if (pageId < 0 || pageId >= pages.length) {
          throw new Error(`Page ${pageId} not found (${pages.length} pages)`);
        }
        await pages[pageId].bringToFront();
        browser.disconnect();
        success(`Selected page ${pageId}: ${pages[pageId].url()}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('new-tab')
    .description('Open a new tab')
    .argument('[url]', 'URL to open', 'about:blank')
    .option('-s, --session <name>', 'Session name')
    .action(async (url: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await browser.newPage();
        if (url !== 'about:blank') {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
        }
        browser.disconnect();
        success(`New tab: ${url}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('close-tab')
    .description('Close a tab by ID')
    .argument('<pageId>', 'Page ID', parseInt)
    .option('-s, --session <name>', 'Session name')
    .action(async (pageId: number, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const pages = await browser.pages();
        if (pageId < 0 || pageId >= pages.length) {
          throw new Error(`Page ${pageId} not found`);
        }
        const url = pages[pageId].url();
        await pages[pageId].close();
        browser.disconnect();
        success(`Closed tab ${pageId}: ${url}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
