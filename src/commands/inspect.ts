import { Command } from 'commander';
import { intArg, floatArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { writeScreenshot } from '../output/image-writer.js';
import { formatTable, success, info, error } from '../output/formatter.js';
import * as refStore from '../core/ref-store.js';
import * as visualCache from '../core/visual-cache.js';
import { dHash } from '../cdp/screenshot-hash.js';
import { getElementInfo } from '../cdp/element-info.js';
import { visionAugment } from '../vision/augment.js';
import { ALL_BACKENDS, DEFAULT_BACKEND, type BackendName } from '../vision/types.js';
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
    .option('--vision [backend]', `Augment with OCR-discovered text in regions a11y missed (default: ${DEFAULT_BACKEND})`)
    .option('--vision-lang <lang>', 'Language(s) for vision OCR (e.g. eng, kor+eng)', 'eng')
    .option('--vision-min-confidence <n>', 'Drop OCR words below this confidence', intArg, 50)
    .option('--vision-iou <n>', 'IoU threshold for "covered by a11y" (0..1)', floatArg, 0.3)
    .option('--vision-contain <n>', 'Contained-in threshold (vision word inside a11y bbox)', floatArg, 0.8)
    .option('--embed', 'Compute semantic embedding for each ref (for RAG retrieval, ~50ms each + first-load model download)')
    .action(async (opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);
        const cdp = await page.createCDPSession();

        const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };

        if (!tree.nodes.length) {
          await cdp.detach();
          browser.disconnect();
          info('Empty snapshot');
          return;
        }

        const { lines, refs: detailed } = renderAXTree(tree.nodes, !opts.verbose);

        // resolve vision backend if requested
        let visionBackend: BackendName | null = null;
        if (opts.vision) {
          const requested = typeof opts.vision === 'string' ? opts.vision : DEFAULT_BACKEND;
          if (!ALL_BACKENDS.includes(requested as BackendName)) {
            await cdp.detach();
            browser.disconnect();
            throw new Error(`Unknown vision backend "${requested}". Valid: ${ALL_BACKENDS.join(', ')}`);
          }
          visionBackend = requested as BackendName;
        }

        // collect cache data and (optional) vision augment while CDP is attached
        let cachePayload: visualCache.CacheEntry | null = null;
        let visionMeta: { backend: string; durationMs: number; total: number; attached: number; orphan: number } | null = null;
        let cacheRefs: visualCache.Waypoint[] = [];

        const needCache = opts.cache !== false;
        const needVision = visionBackend !== null;
        if (needCache || needVision) {
          try {
            const screenshot = await page.screenshot({ type: 'png', optimizeForSpeed: true }) as Buffer;

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

            if (needVision && visionBackend) {
              const aug = await visionAugment(screenshot, cacheRefs, {
                backend: visionBackend,
                lang: opts.visionLang,
                containThreshold: opts.visionContain,
                minConfidence: opts.visionMinConfidence,
              });
              cacheRefs = aug.refs;
              visionMeta = {
                backend: visionBackend,
                durationMs: aug.durationMs,
                total: aug.totalOcrWords,
                attached: aug.attached,
                orphan: aug.orphan,
              };
              if (cachePayload) cachePayload.refs = cacheRefs;
            }
          } catch (e) {
            // best-effort — don't fail snapshot
            if (needVision) info(`vision augment skipped: ${(e as Error).message}`);
          }
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

        if (visionMeta) {
          console.log('');
          console.log(`# vision (${visionMeta.backend}, ${visionMeta.durationMs}ms): ${visionMeta.attached} attached to a11y, ${visionMeta.orphan} orphan, ${visionMeta.total} total OCR words`);
          // visual-only orphan refs
          for (const r of cacheRefs) {
            if (r.channels.a11y) continue;
            const v = r.channels.visual;
            if (!v) continue;
            const conf = (v.ocrConf ?? 0).toString().padStart(3, ' ');
            const bb = `(${v.bbox.x},${v.bbox.y} ${v.bbox.w}x${v.bbox.h})`;
            console.log(`${(r.refId ?? r.id).padEnd(5)} text [${conf}%] ${bb} "${v.ocrText ?? ''}"`);
          }
        }
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
    .option('--limit <n>', 'Max messages', intArg, 50)
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
    .option('--limit <n>', 'Max requests', intArg, 50)
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
