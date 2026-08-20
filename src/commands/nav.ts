import { Command } from 'commander';
import { intArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage, listPages, getPageByHandle } from '../cdp/page-resolver.js';
import { formatTable, success, error } from '../output/formatter.js';

export function registerNavCommands(program: Command): void {
  program
    .command('nav')
    .description('Navigate to a URL')
    .argument('<url>', 'Target URL')
    .option('-s, --session <name>', 'Session name')
    .option('--timeout <ms>', 'Navigation timeout', intArg, 30000)
    .option('--strict', 'Exit non-zero unless response is 2xx')
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

        if (opts.strict && (status < 200 || status >= 300)) {
          error(`${url} (${status}, ${elapsed}ms) — strict: non-2xx`);
          process.exit(1);
        }
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
          p.id,
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
    .description('Select a page/tab by its ID from `tirno pages`')
    .argument('<pageId>', 'Page ID (stable handle, prefix is enough)')
    .option('-s, --session <name>', 'Session name')
    .action(async (pageId: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getPageByHandle(browser, pageId);
        await page.bringToFront();
        browser.disconnect();
        success(`Selected page ${pageId}: ${page.url()}`);
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
    .description('Close a tab by its ID from `tirno pages`')
    .argument('<pageId>', 'Page ID (stable handle, prefix is enough)')
    .option('-s, --session <name>', 'Session name')
    .action(async (pageId: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getPageByHandle(browser, pageId);
        const url = page.url();
        await page.close();
        browser.disconnect();
        success(`Closed tab ${pageId}: ${url}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
