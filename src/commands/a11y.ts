/**
 * `tirno a11y` — 접근성 감사, 위반마다 `@N` (#219).
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { intArg } from '../util/parsers.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage, getInteractivePage, blankAnchorHint } from '../cdp/page-resolver.js';
import { bootUrlOf } from '../core/session-store.js';
import { success, info, warn, fail } from '../output/formatter.js';
import { TirnoError } from '../util/errors.js';
import { renderAXTree, type AXNode } from '../cdp/ax-render.js';
import * as refStore from '../core/ref-store.js';
import type { RefStore } from '../core/ref-store.js';
import type { Page } from '../cdp/page.js';
import { requireElement } from '../cdp/dom-actions.js';
import {
  auditAxTree, auditDom, summarize, sortViolations, RULES, IMPACT_ORDER, type Violation, type Impact, type AuditResult,
} from '../a11y/audit.js';
import { walkTabOrder } from '../a11y/tab-order.js';

/**
 * 감사 한 번. ref store 를 새 세대로 채우므로 위반의 `@N` 이 바로 쓰인다 — `snapshot` 과
 * 같은 번호 규칙(같은 렌더러)이라 그 뒤 `snapshot` 을 찍어도 같은 요소는 같은 번호다.
 */
export async function runAudit(page: Page, session: string, opts: { rules?: string[]; selector?: string }): Promise<AuditResult> {
  const t0 = Date.now();
  const cdp = await page.createCDPSession();
  try {
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const nodes = tree.nodes as unknown as AXNode[];

    // 범위 — 셀렉터 아래의 AX 노드만
    let scope: Set<number> | null = null;
    if (opts.selector) {
      const rootId = (await requireElement(page, opts.selector)).backendNodeId();
      const byId = new Map(nodes.map(n => [n.nodeId, n]));
      const rootAx = nodes.find(n => n.backendDOMNodeId === rootId);
      scope = new Set<number>();
      const walk = (n: AXNode | undefined) => {
        if (!n) return;
        if (n.backendDOMNodeId !== undefined) scope!.add(n.backendDOMNodeId);
        for (const id of n.childIds ?? []) walk(byId.get(id));
      };
      walk(rootAx);
    }

    const wanted = new Set(opts.rules ?? RULES.map(r => r.id));
    const unknown = [...wanted].filter(r => !RULES.some(x => x.id === r));
    if (unknown.length) throw new TirnoError(`unknown rule(s): ${unknown.join(', ')} — ${RULES.map(r => r.id).join(' · ')}`, 'error');

    let violations = [
      ...auditAxTree(nodes, scope),
      ...await auditDom(page, cdp, opts.selector ?? null),
    ].filter(v => wanted.has(v.rule));

    // @N — snapshot 과 같은 렌더러로 번호를 매기고 store 를 채운다
    const { refs } = renderAXTree(nodes, true, true);
    const refOf = new Map(Object.entries(refs).map(([k, v]) => [v.backendId, `@${k}`]));
    violations = violations.map(v => v.backendNodeId !== undefined && refOf.has(v.backendNodeId) ? { ...v, ref: refOf.get(v.backendNodeId) } : v);
    const previous = refStore.load(session);
    const stored: RefStore['refs'] = {};
    for (const [k, v] of Object.entries(refs)) stored[k] = { backendId: v.backendId, role: v.role, name: v.name };
    const loaderId = await cdp.send('Page.getFrameTree').then(t => t.frameTree.frame.loaderId ?? '').catch(() => '');
    refStore.save(session, { schemaVersion: refStore.STORE_SCHEMA_VERSION, generation: previous.generation + 1, url: page.url(), loaderId, capturedAt: new Date().toISOString(), refs: stored });

    return { violations: sortViolations(violations), counts: summarize(violations), rules: [...wanted], nodes: nodes.length, ms: Date.now() - t0 };
  } finally {
    await cdp.detach();
  }
}

const IMPACT_COLOR: Record<Impact, (s: string) => string> = {
  critical: chalk.red, serious: chalk.red, moderate: chalk.yellow, minor: chalk.dim,
};

export function formatViolation(v: Violation): string {
  const ref = v.ref ? `${v.ref} ` : '';
  return `${IMPACT_COLOR[v.impact](`[${v.impact}]`.padEnd(10))} ${v.rule.padEnd(12)} ${ref}${v.target} — ${v.message}; ${chalk.dim(v.fix)}  ${chalk.dim(`WCAG ${v.wcag}`)}`;
}

export function registerA11yCommands(program: Command): void {
  program
    .command('a11y')
    .description(`Accessibility audit of the current page, no external engine. Each violation carries an @N you can \`explain\`/\`click\`. Rules: ${RULES.map(r => r.id).join(' · ')}. --tab-order presses Tab for real and records where focus goes (traps, hidden focus, unnamed stops)`)
    .option('-s, --session <name>', 'Session name')
    .option('--selector <css>', 'Only this subtree')
    .option('--rules <list>', 'Comma-separated rule ids to run (default: all)')
    .option('--tab-order', 'Walk the page with Tab and report the focus order instead of the static audit')
    .option('--max-stops <n>', 'Tab at most this many times', intArg, 60)
    .option('--fail-on <impact>', 'Exit 1 when a violation at this impact or worse exists (critical · serious · moderate · minor)')
    .option('--json', 'Structured output')
    .action(async (opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        if (opts.tabOrder) {
          const page = await getInteractivePage(browser);
          const r = await walkTabOrder(page, { max: opts.maxStops });
          browser.disconnect();
          if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
          info(`tab order (${r.stops.length} stop${r.stops.length === 1 ? '' : 's'}, ${r.problems} problem${r.problems === 1 ? '' : 's'}${r.wrapped ? ', full cycle' : ''})`);
          for (const s of r.stops) {
            const mark = s.problems.length ? chalk.red('✗') : chalk.green('✓');
            console.log(` ${String(s.index).padStart(2)} ${s.desc.padEnd(40)} ${mark}${s.problems.length ? ' ' + s.problems.join(' · ') : ''}`);
          }
          if (r.trapAt !== null) console.log(chalk.red(` ✗ focus trap after ${r.trapAt} stop(s) — Tab did not move on (3 presses); stops above are in the order met, not sorted`));
          if (r.stops.length === 0) warn('nothing took focus — no focusable elements, or Tab is intercepted');
          return;
        }

        const page = await getActivePage(browser);
        const blank = blankAnchorHint(page.url(), bootUrlOf(meta));
        if (blank) warn(blank);
        const rules = opts.rules ? String(opts.rules).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;
        const result = await runAudit(page, meta.name, { rules, selector: opts.selector });
        browser.disconnect();

        if (opts.json) {
          console.log(JSON.stringify({ url: page.url(), ...result }, null, 2));
        } else {
          const c = result.counts;
          const head = `a11y: ${result.violations.length} violation${result.violations.length === 1 ? '' : 's'}` +
            ` (${IMPACT_ORDER.filter(i => c[i]).map(i => `${c[i]} ${i}`).join(' · ') || 'none'})` +
            chalk.dim(`  rules ${result.rules.length} · nodes ${result.nodes} · ${result.ms}ms`);
          if (result.violations.length === 0) success(head);
          else {
            info(head);
            for (const v of result.violations) console.log(formatViolation(v));
            info(`\`tirno click @N\` / \`tirno snapshot\` use the same @N · fix, then \`tirno a11y\` again · \`tirno a11y --tab-order\` for keyboard`);
          }
        }
        if (opts.failOn) {
          const threshold = IMPACT_ORDER.indexOf(opts.failOn as Impact);
          if (threshold === -1) throw new Error(`--fail-on takes one of ${IMPACT_ORDER.join(' · ')}`);
          const hit = result.violations.filter(v => IMPACT_ORDER.indexOf(v.impact) <= threshold);
          if (hit.length) throw new TirnoError(`${hit.length} violation(s) at ${opts.failOn} or worse`, 'a11y_failed', { counts: result.counts });
        }
      } catch (e) {
        fail(e);
      }
    });
}
