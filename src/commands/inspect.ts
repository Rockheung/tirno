import { Command } from 'commander';
import { intArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { writeScreenshot } from '../output/image-writer.js';
import { formatTable, success, info, error } from '../output/formatter.js';
import { captureRequests, type CapturedRequest } from '../cdp/network-capture.js';
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
    .option('--verbose', 'Include everything: ignored nodes, InlineTextBox duplicates, bare layout containers')
    .option('--no-cache', 'Skip visual-cache write')
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

        const { lines, refs: detailed, folded } = renderAXTree(tree.nodes, !opts.verbose, !opts.verbose);

        // collect cache data and (optional) vision augment while CDP is attached
        let cachePayload: visualCache.CacheEntry | null = null;
        let cacheRefs: visualCache.Waypoint[] = [];

        const needCache = opts.cache !== false;
        if (needCache) {
          try {
            {
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

        if (cachePayload) {
          try { visualCache.save(cachePayload); } catch { /* non-fatal */ }
        }

        for (const line of lines) console.log(line);

        // 접었다는 사실은 말해준다 — 안 그러면 "이 페이지에 이것뿐" 과 구별되지 않고,
        // --verbose 가 있다는 것도 알 길이 없다.
        const foldedTotal = folded.inlineTextBox + folded.bareGeneric;
        if (foldedTotal > 0) {
          info(`${foldedTotal} line(s) folded — ${folded.inlineTextBox} InlineTextBox (same text as its StaticText), ${folded.bareGeneric} bare container(s). --verbose shows the full tree.`);
        }

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
    .option('--no-reload', 'Do not reload — listen for --ms and report only what the page requests in that window')
    .option('--ms <n>', 'Listener window when --no-reload is given', intArg, 1000)
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const cdp = await page.createCDPSession();
        const completed = await captureRequests(cdp, page, {
          reload: opts.reload !== false,
          ms: opts.ms,
        });

        let filtered: CapturedRequest[] = completed;
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
        info(`${filtered.length} requests captured${opts.reload === false ? ` in ${opts.ms}ms without reloading — already-received resources are in \`tirno net ls\`` : ''}`);
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

/**
 * a11y 트리를 줄로 편다.
 *
 * `snapshot` 은 이 도구의 핵심 자산이지만, 전체 트리를 그대로 내면 출력이 에이전트
 * 컨텍스트를 두 방향으로 태운다 (#135):
 *
 * 1. **`InlineTextBox` 가 바로 위 `StaticText` 를 그대로 복창한다.** `@ref` 도 안 붙는다
 *    (= 조작 대상이 아니다). 텍스트가 긴 페이지에서 출력이 2배가 되고, 줄바꿈된 텍스트는
 *    InlineTextBox 가 여러 개로 쪼개지므로 2배보다 더 나빠진다. 얻는 정보는 0이다.
 * 2. **이름 없는 `generic` 이 앞을 다 채운다.** instagram 게시물에서는 조작 가능한 첫
 *    요소까지 generic 만 21줄이었다. 이름도 역할값도 없는 순수 레이아웃 컨테이너다.
 *
 * 2번의 손해는 줄 수만이 아니다 — **`@ref` 번호를 먹는다.** 의미 있는 요소의 ref 가 뒤로
 * 밀리면 "@7 을 눌러라" 가 페이지 구조 변화에 더 민감해진다. 그래서 접는 노드는 줄만
 * 안 내는 것이 아니라 번호도 안 받는다: 번호는 실제로 남는 것에만 간다.
 *
 * `--verbose` 는 전부 그대로 낸다. chrome-devtools-mcp / playwright 의 a11y snapshot 도
 * 같은 이유로 generic 컨테이너를 떨어뜨린다.
 */

/** 접힌 뒤 실제로 출력될 노드. 원본 AXNode 와 1:1 이 아니다. */
interface RenderNode {
  role: string;
  name: string;
  value?: string;
  backendId?: number;
  children: RenderNode[];
}

export interface FoldStats {
  /** 부모 StaticText 와 같은 내용이라 안 낸 줄. */
  inlineTextBox: number;
  /** 이름도 역할값도 없어서 자식으로 대체한 컨테이너. */
  bareGeneric: number;
}

const GENERIC_ROLES = new Set(['generic', 'none', 'presentation', 'GenericContainer']);

function isFocusable(node: AXNode): boolean {
  return node.properties?.some(p => p.name === 'focusable' && p.value?.value === true) ?? false;
}

/**
 * 접기 판정. `keep` 이면 그 노드가 한 줄이 되고, 아니면 자식들이 그 자리를 대신한다.
 *
 * 이름도 역할값도 없는 컨테이너라도 **자식이 둘 이상이면 남긴다** — 그때는 묶음이라는
 * 사실 자체가 정보다. 접는 것은 통과용 래퍼(자식 0~1개)뿐이다.
 *
 * focusable 인 generic 은 이름이 없어도 남긴다. a11y 이름이 없는 클릭 가능한 div 는
 * 흔하고, 그것을 접으면 조작 대상이 출력에서 사라진다 — 이 명령이 존재하는 이유가
 * 그 대상을 찾는 것이다.
 */
function foldsAway(node: AXNode, role: string, name: string, hasValue: boolean, childCount: number): boolean {
  if (!GENERIC_ROLES.has(role)) return false;
  if (name || hasValue) return false;
  if (isFocusable(node)) return false;
  return childCount <= 1;
}

function renderAXTree(
  nodes: AXNode[],
  skipIgnored: boolean,
  fold = true,
): { lines: string[]; refs: { [k: string]: DetailedRef }; folded: FoldStats } {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  const folded: FoldStats = { inlineTextBox: 0, bareGeneric: 0 };

  /** 한 AXNode 가 0개(접힘)·1개·여러 개(접히며 자식 승격)의 RenderNode 가 된다. */
  function build(node: AXNode): RenderNode[] {
    const children = (node.childIds ?? [])
      .map(id => byId.get(id))
      .filter((c): c is AXNode => c !== undefined)
      .flatMap(build);

    // 원래 있던 동작: ignored 는 안 내되 자식은 그 깊이로 올라온다.
    if (skipIgnored && node.ignored) return children;

    const role = String(node.role?.value ?? '?');
    const name = node.name?.value ? String(node.name.value) : '';
    const hasValue = node.value?.value !== undefined;

    if (fold && role === 'InlineTextBox') {
      folded.inlineTextBox++;
      return children;
    }
    if (fold && foldsAway(node, role, name, hasValue, children.length)) {
      folded.bareGeneric++;
      return children;
    }

    const out: RenderNode = { role, name, children };
    if (hasValue) out.value = JSON.stringify(node.value!.value);
    if (node.backendDOMNodeId !== undefined) out.backendId = node.backendDOMNodeId;
    return [out];
  }

  const lines: string[] = [];
  const refs: { [k: string]: DetailedRef } = {};
  let counter = 0;

  function emit(node: RenderNode, depth: number): void {
    let prefix = '   '; // 3 spaces when no ref
    if (node.backendId !== undefined) {
      counter++;
      refs[String(counter)] = { backendId: node.backendId, role: node.role, name: node.name };
      prefix = `@${counter}`.padEnd(4, ' ');
    }
    const name = node.name ? ` "${node.name}"` : '';
    const value = node.value !== undefined ? ` value=${node.value}` : '';
    lines.push(`${prefix}${'  '.repeat(depth)}${node.role}${name}${value}`);
    for (const child of node.children) emit(child, depth + 1);
  }

  for (const top of build(root)) emit(top, 0);
  return { lines, refs, folded };
}

export const __test__ = { renderAXTree };
