import { Command } from 'commander';
import { intArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { writeScreenshot } from '../output/image-writer.js';
import { formatTable, success, info, error } from '../output/formatter.js';
import * as refStore from '../core/ref-store.js';
import * as visualCache from '../core/visual-cache.js';
import { dHash } from '../cdp/screenshot-hash.js';
import { getElementInfo } from '../cdp/element-info.js';
import type { Bbox } from '../cdp/iou.js';
import type { ScreenshotOptions } from 'puppeteer-core';

export function registerInspectCommands(program: Command): void {
  program
    .command('screenshot')
    .description('Take a screenshot')
    .option('-s, --session <name>', 'Session name')
    .option('--out <path>', 'Output file path')
    .option('--full', 'Full page screenshot')
    .option('--format <type>', 'Image format (png|jpeg|webp)', 'png')
    .option('--quality <n>', 'JPEG/WebP quality (0-100)', intArg)
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
    .option('--no-cache', 'Skip visual-cache write')
    .option('--embed', 'Compute semantic embedding for each ref (for RAG retrieval, ~50ms each + first-load model download)')
    .action(async (opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);
        const cdp = await page.createCDPSession();

        // Chrome builds the accessibility tree off a rendered frame. Ask for it
        // before anything has painted and it comes back with the root and
        // nothing else — which made the FIRST snapshot of every session look
        // like an empty page (headless and headful alike) and pushed callers
        // down to the LLM step for nothing. Capturing forces that frame, and
        // the same buffer is reused for the cache below, so the default path
        // pays nothing extra.
        const screenshot = await page.screenshot({ type: 'png', optimizeForSpeed: true }) as Buffer;

        const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };

        if (!tree.nodes.length) {
          await cdp.detach();
          browser.disconnect();
          info('Empty snapshot');
          return;
        }

        const { lines, refs: detailed } = renderAXTree(tree.nodes, !opts.verbose);

        // collect cache data and (optional) vision augment while CDP is attached
        let cachePayload: visualCache.CacheEntry | null = null;
        let cacheRefs: visualCache.Waypoint[] = [];

        const needCache = opts.cache !== false;
        if (needCache) {
          try {
            if (needCache) {
              const url = page.url();
              const viewport = await page.evaluate(() => ({
                w: window.innerWidth,
                h: window.innerHeight,
                dpr: window.devicePixelRatio,
              }));
              const refEntries = Object.entries(detailed);
              type MaybeInfo = { selector?: string; bbox?: Bbox };
              const elementInfos = await Promise.all(
                refEntries.map(([, v]) => getElementInfo(cdp, v.backendId).catch((): MaybeInfo => ({})))
              );
              cacheRefs = refEntries.map(([k, v], i) => {
                const info: MaybeInfo = elementInfos[i] ?? {};
                const channels: visualCache.Waypoint['channels'] = {
                  a11y: { role: v.role, name: v.name, backendId: v.backendId },
                };
                if (info.selector) channels.dom = { selector: info.selector };
                if (info.bbox) channels.visual = { bbox: info.bbox };
                return {
                  id: `@${k}`,
                  refId: `@${k}`,
                  channels,
                };
              });
              const visualFp = await dHash(screenshot);
              const key = visualCache.parseUrl(url);
              cachePayload = {
                schemaVersion: visualCache.ENTRY_SCHEMA_VERSION,
                url: key.fullUrl,
                urlPath: key.urlPath,
                domain: key.domain,
                capturedAt: new Date().toISOString(),
                visualFp,
                viewport,
                refs: cacheRefs,
              };
            }

          } catch { /* best-effort — a cache write must not fail the snapshot */ }
        }

        await cdp.detach();
        browser.disconnect();

        // flat refs for ref-store (backward compatible — a11y only)
        const flatRefs: refStore.RefMap = {};
        for (const [k, v] of Object.entries(detailed)) flatRefs[k] = v.backendId;
        refStore.save(meta.name, flatRefs);

        // optional embeddings — compute before cache save so they persist
        if (opts.embed && cachePayload) {
          try {
            const { embed, buildEmbedText } = await import('../intelligence/embedding.js');
            for (const r of cachePayload.refs) {
              const text = buildEmbedText(r, cachePayload.url);
              if (!text.trim()) continue;
              const emb = await embed(text);
              r.embedding = Array.from(emb);
            }
          } catch (e) {
            info(`embed skipped: ${(e as Error).message}`);
          }
        }

        if (cachePayload) {
          try { visualCache.save(cachePayload); } catch { /* non-fatal */ }
        }

        for (const line of lines) console.log(line);

      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('console')
    .description('List console messages (one-shot capture window; use --reload to re-trigger page-load logs)')
    .option('-s, --session <name>', 'Session name')
    .option('--type <type>', 'Filter by type (log|error|warn|info)')
    .option('--limit <n>', 'Max messages', intArg, 50)
    .option('--show <id>', 'Print full detail of the message at zero-based index <id>', intArg)
    .option('--json', 'Output as JSON array')
    .option('--reload', 'Reload the page while listening — captures on-load console output')
    .option('--ms <n>', 'Listener window in ms (default 500)', intArg, 500)
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        interface FullMsg {
          id: number;
          type: string;
          text: string;
          location?: { url?: string; lineNumber?: number; columnNumber?: number };
          args?: string[];
          stackFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number }>;
        }

        const messages: FullMsg[] = [];
        const listener = (msg: import('puppeteer-core').ConsoleMessage) => {
          if (opts.type && msg.type() !== opts.type) return;
          const loc = msg.location();
          const stack = msg.stackTrace().map(f => ({
            url: f.url, lineNumber: f.lineNumber, columnNumber: f.columnNumber,
          }));
          messages.push({
            id: messages.length,
            type: msg.type(),
            text: msg.text(),
            location: { url: loc.url, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber },
            args: msg.args().map(a => String(a)),
            stackFrames: stack.length ? stack : undefined,
          });
        };

        page.on('console', listener);
        if (opts.reload) {
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        } else {
          await page.evaluate(() => void 0);
        }
        await new Promise(r => setTimeout(r, opts.ms));
        page.off('console', listener);
        browser.disconnect();

        if (opts.show !== undefined) {
          const idx = Number(opts.show);
          const m = messages[idx];
          if (!m) {
            error(`No console message at index ${idx} (captured ${messages.length})`);
            process.exit(1);
          }
          console.log(JSON.stringify(m, null, 2));
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(messages.slice(0, opts.limit), null, 2));
          return;
        }

        if (messages.length === 0) {
          info('No console messages captured');
          return;
        }

        for (const msg of messages.slice(0, opts.limit)) {
          const prefix = msg.type === 'error' ? '✗' : msg.type === 'warning' ? '⚠' : '·';
          console.log(`${String(msg.id).padStart(3)} ${prefix} [${msg.type}] ${msg.text}`);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('network')
    .description('List recent network requests (reloads + captures; --show <id> for full detail incl. body)')
    .option('-s, --session <name>', 'Session name')
    .option('--type <type>', 'Filter by resource type')
    .option('--limit <n>', 'Max requests', intArg, 50)
    .option('--show <id>', 'Print full detail (headers + body) of the request at zero-based index <id>', intArg)
    .option('--json', 'Output as JSON array')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');

        interface FullReq {
          id: number;
          requestId: string;
          url: string;
          method: string;
          status: number;
          type: string;
          requestHeaders?: Record<string, string>;
          responseHeaders?: Record<string, string>;
          postData?: string;
          mimeType?: string;
        }

        const completed: FullReq[] = [];
        const pending = new Map<string, Partial<FullReq>>();

        cdp.on('Network.requestWillBeSent', (params) => {
          const req = params as unknown as {
            requestId: string;
            request: { url: string; method: string; headers: Record<string, string>; postData?: string };
            type: string;
          };
          pending.set(req.requestId, {
            requestId: req.requestId,
            url: req.request.url,
            method: req.request.method,
            type: req.type,
            requestHeaders: req.request.headers,
            postData: req.request.postData,
          });
        });

        cdp.on('Network.responseReceived', (params) => {
          const resp = params as unknown as {
            requestId: string;
            response: { status: number; headers: Record<string, string>; mimeType: string };
            type: string;
          };
          const partial = pending.get(resp.requestId);
          if (partial) {
            const full: FullReq = {
              id: completed.length,
              requestId: partial.requestId!,
              url: partial.url!,
              method: partial.method!,
              status: resp.response.status,
              type: resp.type,
              requestHeaders: partial.requestHeaders,
              responseHeaders: resp.response.headers,
              mimeType: resp.response.mimeType,
              postData: partial.postData,
            };
            completed.push(full);
            pending.delete(resp.requestId);
          }
        });

        // reload to capture requests
        await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});

        let filtered = completed;
        if (opts.type) {
          filtered = completed.filter(r => r.type.toLowerCase() === opts.type.toLowerCase());
        }

        if (opts.show !== undefined) {
          const idx = Number(opts.show);
          const r = filtered[idx];
          if (!r) {
            await cdp.detach();
            browser.disconnect();
            error(`No request at index ${idx} (captured ${filtered.length})`);
            process.exit(1);
          }
          let body: string | undefined;
          let bodyBase64 = false;
          let bodyError: string | undefined;
          try {
            const res = await cdp.send('Network.getResponseBody', { requestId: r.requestId }) as { body: string; base64Encoded: boolean };
            body = res.body;
            bodyBase64 = res.base64Encoded;
          } catch (e) {
            bodyError = (e as Error).message;
          }
          await cdp.detach();
          browser.disconnect();
          console.log(JSON.stringify({ ...r, body, bodyBase64, bodyError }, null, 2));
          return;
        }

        await cdp.detach();
        browser.disconnect();

        if (opts.json) {
          console.log(JSON.stringify(filtered.slice(0, opts.limit), null, 2));
          return;
        }

        const rows = filtered.slice(0, opts.limit).map(r => [
          String(r.id).padStart(3),
          r.method,
          String(r.status),
          r.type,
          r.url.slice(0, 80),
        ]);
        console.log(formatTable(['ID', 'METHOD', 'STATUS', 'TYPE', 'URL'], rows));
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

interface DetailedRef {
  backendId: number;
  role: string;
  name: string;
}

function renderAXTree(nodes: AXNode[], skipIgnored: boolean): { lines: string[]; refs: { [k: string]: DetailedRef } } {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  const lines: string[] = [];
  const refs: { [k: string]: DetailedRef } = {};
  let counter = 0;

  function walk(node: AXNode, depth: number): void {
    const skip = skipIgnored && node.ignored;
    let nextDepth = depth;
    if (!skip) {
      const role = String(node.role?.value ?? '?');
      const nameValue = node.name?.value ? String(node.name.value) : '';
      const name = nameValue ? ` "${nameValue}"` : '';
      const value = node.value?.value !== undefined ? ` value=${JSON.stringify(node.value.value)}` : '';
      const indent = '  '.repeat(depth);
      let prefix = '   '; // 3 spaces when no ref
      if (node.backendDOMNodeId !== undefined) {
        counter++;
        refs[String(counter)] = { backendId: node.backendDOMNodeId, role, name: nameValue };
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
