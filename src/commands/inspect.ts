import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { writeScreenshot } from '../output/image-writer.js';
import { formatTable, success, info, error } from '../output/formatter.js';
import * as refStore from '../core/ref-store.js';
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
    .option('--verbose', 'Include all elements (default: skip ignored)')
    .action(async (opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);
        const cdp = await page.createCDPSession();

        const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };
        await cdp.detach();
        browser.disconnect();

        if (!tree.nodes.length) {
          info('Empty snapshot');
          return;
        }

        const { lines, refs } = renderAXTree(tree.nodes, !opts.verbose);
        refStore.save(meta.name, refs);
        for (const line of lines) console.log(line);
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

interface AXValue { value?: string | number | boolean }
interface AXProperty { name: string; value: AXValue }
interface AXNode {
  nodeId: string;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  ignored?: boolean;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  properties?: AXProperty[];
}

function renderAXTree(nodes: AXNode[], skipIgnored: boolean): { lines: string[]; refs: { [k: string]: number } } {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  const lines: string[] = [];
  const refs: { [k: string]: number } = {};
  let counter = 0;

  function walk(node: AXNode, depth: number): void {
    const skip = skipIgnored && node.ignored;
    let nextDepth = depth;
    if (!skip) {
      const role = String(node.role?.value ?? '?');
      const name = node.name?.value ? ` "${String(node.name.value)}"` : '';
      const value = node.value?.value !== undefined ? ` value=${JSON.stringify(node.value.value)}` : '';
      const indent = '  '.repeat(depth);
      let prefix = '   '; // 3 spaces when no ref
      if (node.backendDOMNodeId !== undefined) {
        counter++;
        refs[String(counter)] = node.backendDOMNodeId;
        prefix = `@${counter}`.padEnd(4, ' ');
      }
      lines.push(`${prefix}${indent}${role}${name}${value}`);
      nextDepth = depth + 1;
    }
    for (const cid of node.childIds ?? []) {
      const child = byId.get(cid);
      if (child) walk(child, nextDepth);
    }
  }

  walk(root, 0);
  return { lines, refs };
}
