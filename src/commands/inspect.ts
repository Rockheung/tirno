import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { writeScreenshot } from '../output/image-writer.js';
import { formatTable, success, info, error } from '../output/formatter.js';
import type { ScreenshotOptions } from 'puppeteer-core';

export function registerInspectCommands(program: Command): void {
  program
    .command('screenshot')
    .description('Take a screenshot')
    .option('-s, --session <name>', 'Session name')
    .option('--out <path>', 'Output file path')
    .option('--full', 'Full page screenshot')
    .option('--format <type>', 'Image format (png|jpeg|webp)', 'png')
    .option('--quality <n>', 'JPEG/WebP quality (0-100)', parseInt)
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const screenshotOpts: ScreenshotOptions = {
          type: opts.format as 'png' | 'jpeg' | 'webp',
          fullPage: opts.full ?? false,
          optimizeForSpeed: true,
        };
        if (opts.quality !== undefined) screenshotOpts.quality = opts.quality;

        const buffer = await page.screenshot(screenshotOpts);
        browser.disconnect();

        const buf = buffer as Buffer;
        const filepath = writeScreenshot(buf, opts.out, opts.format);
        let size = `${(buf.length / 1024).toFixed(1)}KB`;
        if (opts.format === 'png' && buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
          size = `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
        }
        success(`${filepath} (${size})`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('snapshot')
    .description('Take an accessibility tree snapshot')
    .option('-s, --session <name>', 'Session name')
    .option('--verbose', 'Include hidden elements')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const snapshot = await page.accessibility.snapshot({ interestingOnly: !opts.verbose });
        browser.disconnect();

        if (!snapshot) {
          info('Empty snapshot');
          return;
        }

        printA11yTree(snapshot, 0);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('console')
    .description('List console messages (requires active CDP listener)')
    .option('-s, --session <name>', 'Session name')
    .option('--type <type>', 'Filter by type (log|error|warn|info)')
    .option('--limit <n>', 'Max messages', parseInt, 50)
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        // listen for messages during a brief period
        const messages: Array<{ type: string; text: string }> = [];
        const listener = (msg: import('puppeteer-core').ConsoleMessage) => {
          if (opts.type && msg.type() !== opts.type) return;
          messages.push({ type: msg.type(), text: msg.text() });
        };

        page.on('console', listener);
        // evaluate a no-op to trigger any pending console flush
        await page.evaluate(() => void 0);
        await new Promise(r => setTimeout(r, 500));
        page.off('console', listener);
        browser.disconnect();

        if (messages.length === 0) {
          info('No console messages captured');
          return;
        }

        for (const msg of messages.slice(0, opts.limit)) {
          const prefix = msg.type === 'error' ? '✗' : msg.type === 'warning' ? '⚠' : '·';
          console.log(`${prefix} [${msg.type}] ${msg.text}`);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('network')
    .description('List recent network requests (captures for 2s)')
    .option('-s, --session <name>', 'Session name')
    .option('--type <type>', 'Filter by resource type')
    .option('--limit <n>', 'Max requests', parseInt, 50)
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');

        const requests: Array<{ url: string; method: string; status: number; type: string }> = [];
        const pending = new Map<string, { url: string; method: string; type: string }>();

        cdp.on('Network.requestWillBeSent', (params) => {
          const req = params as unknown as { requestId: string; request: { url: string; method: string }; type: string };
          pending.set(req.requestId, { url: req.request.url, method: req.request.method, type: req.type });
        });

        cdp.on('Network.responseReceived', (params) => {
          const resp = params as unknown as { requestId: string; response: { status: number }; type: string };
          const req = pending.get(resp.requestId);
          if (req) {
            requests.push({ ...req, status: resp.response.status, type: resp.type });
            pending.delete(resp.requestId);
          }
        });

        // reload to capture requests
        await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
        await cdp.detach();
        browser.disconnect();

        let filtered = requests;
        if (opts.type) {
          filtered = requests.filter(r => r.type.toLowerCase() === opts.type.toLowerCase());
        }

        const rows = filtered.slice(0, opts.limit).map(r => [
          r.method,
          String(r.status),
          r.type,
          r.url.slice(0, 80),
        ]);
        console.log(formatTable(['METHOD', 'STATUS', 'TYPE', 'URL'], rows));
        info(`${filtered.length} requests captured`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}

function printA11yTree(node: import('puppeteer-core').SerializedAXNode, depth: number): void {
  const indent = '  '.repeat(depth);
  const name = node.name ? ` "${node.name}"` : '';
  const value = node.value ? ` value="${node.value}"` : '';
  console.log(`${indent}${node.role}${name}${value}`);
  if (node.children) {
    for (const child of node.children) {
      printA11yTree(child, depth + 1);
    }
  }
}
