// tirno explore <goal> — tirno의 메인 가치 흐름.
//
// 1. cache lookup (existing trail with same goal + high success-rate → replay)
// 2. snapshot 현재 페이지 (multi-channel context: a11y + selector + bbox + ocr)
// 3. LLM ask → ProposedAction
// 4. action 실행 → step 누적 → 다음 iteration
// 5. action.type === 'done' → trail 저장
// 6. action.type === 'give_up' OR maxSteps 도달 → 마지막 보루: 사용자에게
//    `tirno trail capture` 안내

import { Command } from 'commander';
import { intArg, floatArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { ask as intelligenceAsk } from '../intelligence/dispatcher.js';
import type { BackendName, ProposedAction } from '../intelligence/types.js';
import { getTrailStore } from '../storage/index.js';
import type { Trail, TrailStep } from '../core/trail-store.js';
import type { RecordedEvent } from '../core/record-store.js';
import { success, info, warn, error } from '../output/formatter.js';
import type { Page, CDPSession } from 'puppeteer-core';

interface AXNode {
  nodeId: string;
  role?: { value?: unknown };
  name?: { value?: unknown };
  ignored?: boolean;
  childIds?: string[];
  parentId?: string;
}

function renderAXDump(nodes: AXNode[], maxLines = 200): string {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  const lines: string[] = [];
  const walk = (n: AXNode, depth: number): void => {
    if (lines.length >= maxLines) return;
    if (!n.ignored) {
      const role = String((n.role?.value as string | undefined) ?? '?');
      const name = n.name?.value ? ` "${String(n.name.value)}"` : '';
      lines.push(`${'  '.repeat(depth)}${role}${name}`);
    }
    for (const cid of n.childIds ?? []) {
      const c = byId.get(cid);
      if (c) walk(c, n.ignored ? depth : depth + 1);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}

interface PageContext {
  url: string;
  viewport: { w: number; h: number; dpr: number };
  screenshot: Buffer;
  a11yDump: string;
}

async function capturePageContext(page: Page, axLines: number): Promise<PageContext> {
  const screenshot = await page.screenshot({ type: 'png', optimizeForSpeed: true }) as Buffer;
  const cdp = await page.createCDPSession();
  let a11yDump = '';
  try {
    const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };
    a11yDump = renderAXDump(tree.nodes, axLines);
  } finally {
    await cdp.detach();
  }
  const viewport = await page.evaluate(() => ({
    w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
  }));
  return { url: page.url(), viewport, screenshot, a11yDump };
}

async function resolveTargetXY(page: Page, action: ProposedAction): Promise<[number, number] | null> {
  const t = action.target;
  if (!t) return null;
  if (typeof t.x === 'number' && typeof t.y === 'number') return [t.x, t.y];
  if (t.selector) {
    const xy = await page.evaluate((s: string) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    }, t.selector).catch(() => null);
    if (xy) return [xy[0], xy[1]];
  }
  if (t.role && t.name) {
    const xy = await page.evaluate(({ r, n }: { r: string; n: string }) => {
      for (const el of document.querySelectorAll('*')) {
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        if (role !== r) continue;
        const name = el.getAttribute('aria-label') || (el.textContent ?? '').trim().slice(0, 80);
        if (name !== n) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        return [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)];
      }
      return null;
    }, { r: t.role, n: t.name }).catch(() => null);
    if (xy) return [xy[0], xy[1]];
  }
  return null;
}

async function executeAction(
  page: Page,
  cdp: CDPSession,
  action: ProposedAction,
): Promise<{ ok: boolean; event?: RecordedEvent; reason?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = cdp.send.bind(cdp) as any;

  switch (action.type) {
    case 'click': {
      const xy = await resolveTargetXY(page, action);
      if (!xy) return { ok: false, reason: 'click target unresolvable' };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: xy[0], y: xy[1] });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: xy[0], y: xy[1], button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xy[0], y: xy[1], button: 'left', clickCount: 1 });
      return {
        ok: true,
        event: {
          type: 'click',
          t: 0,
          x: xy[0], y: xy[1],
          channels: {
            a11y: action.target?.role || action.target?.name ? { role: action.target?.role, name: action.target?.name } : undefined,
            dom: action.target?.selector ? { selector: action.target.selector } : undefined,
          },
        },
      };
    }
    case 'fill': {
      const sel = action.target?.selector;
      if (!sel || action.value === undefined) return { ok: false, reason: 'fill needs selector + value' };
      const filled = await page.evaluate((s: string, v: string) => {
        const el = document.querySelector(s) as HTMLInputElement | null;
        if (!el) return false;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, sel, action.value).catch(() => false);
      if (!filled) return { ok: false, reason: `fill: element ${sel} not found` };
      return {
        ok: true,
        event: { type: 'input', t: 0, value: action.value, channels: { dom: { selector: sel } } },
      };
    }
    case 'press': {
      if (!action.value) return { ok: false, reason: 'press needs value (key)' };
      const isPrintable = action.value.length === 1;
      await send('Input.dispatchKeyEvent', isPrintable
        ? { type: 'keyDown', key: action.value, text: action.value }
        : { type: 'keyDown', key: action.value });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: action.value });
      return { ok: true, event: { type: 'keydown', t: 0, key: action.value } };
    }
    case 'wait': {
      const ms = action.ms ?? 500;
      await new Promise(r => setTimeout(r, ms));
      return { ok: true };
    }
    case 'nav': {
      if (!action.url) return { ok: false, reason: 'nav needs url' };
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { ok: true };
    }
    case 'scroll': {
      const y = action.scrollY ?? 0;
      await page.evaluate((sy: number) => window.scrollTo({ top: sy, behavior: 'instant' as ScrollBehavior }), y);
      return {
        ok: true,
        event: { type: 'scroll', t: 0, y },
      };
    }
    default:
      return { ok: false, reason: `unsupported action type: ${action.type}` };
  }
}

export function registerExploreCommand(program: Command): void {
  program
    .command('explore <goal>')
    .description(
      '[메인 가치 흐름] cache → multi-channel → CDP → LLM → 시도 → 누적. ' +
      '성공 시 trail로 저장. 모든 자율 시도 실패 시 사용자 시연 부탁.'
    )
    .option('-s, --session <name>', 'Session name')
    .option('--backend <name>', 'Intelligence backend', 'claude')
    .option('--max-steps <n>', 'Max LLM iterations', intArg, 10)
    .option('--ax-lines <n>', 'a11y dump lines per ask', intArg, 200)
    .option('--max-tokens <n>', 'LLM response max tokens', intArg, 1024)
    .option('--save <name>', 'Save resulting trail under name')
    .option('--no-cache', 'Skip cache lookup (force LLM iteration)')
    .option('--retry-threshold <n>', 'Use existing trail if successRate above this', floatArg, 0.5)
    .option('--verbose', 'Per-step LLM reasoning + cost')
    .action(async (goal: string, opts) => {
      try {
        const trailStore = await getTrailStore();
        const startUrl = (await (async () => {
          const { browser: b } = await connect(opts.session);
          const p = await getActivePage(b);
          const u = p.url();
          b.disconnect();
          return u;
        })());

        // 1. cache lookup — existing trail with same goal + high success rate
        if (opts.cache !== false) {
          const candidates = await trailStore.query({ goal, minSuccessRate: opts.retryThreshold, limit: 1 });
          if (candidates.length > 0) {
            const t = candidates[0];
            info(`cache hit: trail "${t.name}" (${t.matchStats?.successCount}/${t.matchStats?.runCount} success). Use "tirno trail replay ${t.name}" to run it.`);
            success(`explore done via cache (no LLM call). Trail: ${t.name}`);
            return;
          }
        }

        // 2..N. iteration loop
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const cdp = await page.createCDPSession();

        const steps: TrailStep[] = [];
        let totalCost = 0;
        let lastReason = '';
        let outcome: 'done' | 'give_up' | 'max_steps' = 'max_steps';

        for (let i = 0; i < opts.maxSteps; i++) {
          const ctx = await capturePageContext(page, opts.axLines);
          const askStart = Date.now();
          const response = await intelligenceAsk(opts.backend as BackendName, {
            goal,
            ask: 'next_action',
            context: {
              pageUrl: ctx.url,
              viewport: ctx.viewport,
              screenshot: ctx.screenshot,
              a11yDump: ctx.a11yDump,
            },
            maxTokens: opts.maxTokens,
          });
          const askMs = Date.now() - askStart;
          totalCost += response.usage?.estimatedCostUsd ?? 0;

          if (opts.verbose) {
            info(`step ${i + 1}: action=${response.action?.type} (${askMs}ms, ~$${(response.usage?.estimatedCostUsd ?? 0).toFixed(4)})`);
            info(`  reasoning: ${response.reasoning.slice(0, 200)}`);
          }

          if (!response.action) {
            warn(`step ${i + 1}: no action returned. reasoning: ${response.reasoning.slice(0, 200)}`);
            outcome = 'give_up';
            lastReason = response.reasoning;
            break;
          }

          const a = response.action;
          if (a.type === 'done') {
            outcome = 'done';
            lastReason = a.reason ?? response.reasoning;
            break;
          }
          if (a.type === 'give_up') {
            outcome = 'give_up';
            lastReason = a.reason ?? response.reasoning;
            break;
          }

          const result = await executeAction(page, cdp, a);
          if (!result.ok) {
            warn(`step ${i + 1}: action failed — ${result.reason ?? 'unknown'}`);
            // continue iteration; LLM may try a different approach next round
          }
          if (result.event) {
            result.event.t = i;  // step index as time placeholder
            steps.push({ event: result.event });
          }
        }

        await cdp.detach();
        browser.disconnect();

        // 5/6. save trail (or instruct user to capture)
        if (outcome === 'done' && opts.save) {
          const trail: Trail = {
            name: opts.save,
            goal,
            startUrl,
            capturedAt: new Date().toISOString(),
            durationMs: 0,
            steps,
            matchStats: { runCount: 1, successCount: 1, lastRunAt: new Date().toISOString() },
          };
          await trailStore.save(trail);
          success(`Goal reached. Trail "${opts.save}" saved (${steps.length} steps, ~$${totalCost.toFixed(4)})`);
        } else if (outcome === 'done') {
          success(`Goal reached (${steps.length} actions, ~$${totalCost.toFixed(4)}). Use --save <name> to persist.`);
        } else {
          warn(`outcome=${outcome}, ${steps.length} actions, ~$${totalCost.toFixed(4)}`);
          if (lastReason) info(`reason: ${lastReason}`);
          info('— 자율 탐색 한계. 마지막 보루로 사용자 시연을 부탁:');
          info(`  tirno trail capture <name>`);
          info(`  # 시연 후`);
          info(`  tirno trail save`);
          process.exit(2);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
