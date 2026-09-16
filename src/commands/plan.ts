/**
 * `plan` / `apply` — 파일에 상태를 선언하고, 실행 전에 판정하고, 적용한다 (#212).
 *
 * `plan` 은 실행하지 않는다. 지금 페이지와 캐시로 단계마다 "될지 · 모호한지 · 없는지 · 아직
 * 모르는지" 를 말한다. `apply` 는 레시피와 같은 실행기로 단계를 친다 — `--group` 이면
 * 세션마다 동시에 치고 결과 매트릭스를 낸다. `broadcast` 의 선언형이다.
 */
import { Command } from 'commander';
import fs from 'node:fs';
import chalk from 'chalk';
import * as store from '../core/session-store.js';
import * as recipes from '../core/recipe-store.js';
import * as visualCache from '../core/visual-cache.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, info, fail, formatTable } from '../output/formatter.js';
import { TirnoError, NoActiveSession } from '../util/errors.js';
import { loadPlan, planFromRecipe, type PlanFile } from '../core/plan-file.js';
import { runSteps, masker } from '../core/step-runner.js';
import { takesName, findByRoleName, axRole } from '../cdp/target.js';
import { parseClause, observe } from './declare.js';
import type { Page } from '../cdp/page.js';

/** 파일이면 파일, 아니면 레시피 이름 */
function loadTarget(what: string, domain?: string): PlanFile {
  if (fs.existsSync(what)) return loadPlan(what);
  if (/[/.]/.test(what) && !/^[A-Za-z0-9_-]+$/.test(what)) throw new Error(`no such file: ${what}`);
  return planFromRecipe(recipes.find(what, domain));
}

// ------------------------------------------------------------- plan

type Verdict = 'already' | 'will' | 'found' | 'cached' | 'ambiguous' | 'missing' | 'unknown' | 'holds' | 'fails' | 'observe' | 'ref';

interface Judgment { index: number; argv: string[]; verdict: Verdict; note: string }

const NAV = new Set(['nav', 'back', 'forward', 'reload']);
const TARGETED = new Set(['click', 'fill', 'hover', 'upload', 'wait-for', 'select', 'scroll']);

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => { try { const x = new URL(u); x.hash = ''; return x.href.replace(/\/$/, ''); } catch { return u; } };
  return norm(a) === norm(b);
}

/** 캐시 항목에서 role+이름을 찾는다 — 실행 전 판정용 */
function inCache(entry: visualCache.CacheEntry | null, role: string, name: string | undefined): number {
  if (!entry) return 0;
  const needle = name?.toLowerCase();
  return entry.refs.filter(w => {
    const a = w.channels.a11y;
    if (!a || a.role !== role) return false;
    return needle === undefined || a.name.toLowerCase().includes(needle);
  }).length;
}

export async function judgePlan(plan: PlanFile, page: Page, session: string, values: Record<string, string>): Promise<Judgment[]> {
  const out: Judgment[] = [];
  let cursorUrl: string | null = page.url();
  let live = true;
  let unknownSince: number | null = null;
  let cached: visualCache.CacheEntry | null = null;

  const leave = (index: number, url: string | null) => {
    cursorUrl = url; live = false; unknownSince = index;
    cached = url ? visualCache.lookup(url) : null;
  };

  for (let i = 0; i < plan.steps.length; i++) {
    const argv = recipes.expandVars(plan.steps[i], values, { ...process.env, ...Object.fromEntries(plan.vars.map(v => [v, process.env[v] ?? `$${v}`])) });
    const index = i + 1;
    const [cmd, ...rest] = argv;
    const push = (verdict: Verdict, note: string) => out.push({ index, argv, verdict, note });

    if (cmd === 'nav' || (cmd === 'ensure' && rest[0] === 'url')) {
      const url = cmd === 'nav' ? rest[0] : rest[1];
      if (cursorUrl && sameUrl(cursorUrl, url)) { push('already', `already at ${url}`); continue; }
      push('will', `will navigate (now: ${cursorUrl ?? 'unknown'})`);
      leave(index, url);
      continue;
    }
    if (NAV.has(cmd)) { push('will', `will ${cmd}`); leave(index, null); continue; }

    // 대상이 있는 단계 — click button "X" / fill textbox "Y" v / ensure textbox "Y" = v / wait-for …
    let roleWord: string | undefined, name: string | undefined, selector: string | undefined, ref: string | undefined;
    if (TARGETED.has(cmd) && rest[0]) {
      if (takesName(rest[0])) { roleWord = rest[0]; name = rest[1]; }
      else if (/^@/.test(rest[0])) ref = rest[0];
      else if (!/^-?\d+,-?\d+$/.test(rest[0])) selector = rest[0];
    } else if (cmd === 'ensure' && rest[0] && takesName(rest[0])) { roleWord = rest[0]; name = takesName(rest[0]) && rest[1] && !['=', 'is', 'checked', 'unchecked', 'focused'].includes(rest[1]) ? rest[1] : undefined; }
    else if (cmd === 'ensure' && ['value', 'checked', 'unchecked', 'focused', 'visible', 'hidden'].includes(rest[0]) && rest[1] && takesName(rest[1])) { roleWord = rest[1]; name = rest[2]; }

    if (ref) { push('ref', `${ref} is a snapshot ref — it will not resolve on replay; use role + name`); continue; }

    if (roleWord) {
      const role = axRole(roleWord);
      if (live) {
        const cdp = await page.createCDPSession();
        let n: number;
        try { n = (await findByRoleName(cdp, role, name, false)).length; } finally { await cdp.detach(); }
        if (n === 1) push('found', 'found on the page (a11y) · 1 candidate');
        else if (n > 1) push('ambiguous', `${n} candidates on the page — be exact, or use @N`);
        else {
          const c = inCache(cursorUrl ? visualCache.lookup(cursorUrl) : null, role, name);
          push(c ? 'cached' : 'missing', c ? `not on the page now, but in cache (${c}) — will resolve live` : 'NOT on the page now');
        }
      } else {
        const c = inCache(cached, role, name);
        if (c === 1) push('cached', 'in cache (a11y) · 1 candidate');
        else if (c > 1) push('cached', `in cache (a11y) · ${c} candidates — may be ambiguous`);
        else push('unknown', cached ? `NOT in cache for ${cursorUrl} — will resolve live` : `unknown until step ${unknownSince}`);
      }
      continue;
    }
    if (selector) {
      if (live) {
        const el = await page.$(selector).catch(() => null) ?? await page.$(`pierce/${selector}`).catch(() => null);
        push(el ? 'found' : 'missing', el ? 'found on the page (selector)' : 'NOT on the page now (selector)');
      } else push('unknown', `unknown until step ${unknownSince}`);
      continue;
    }

    if (cmd === 'expect') {
      if (live) {
        try {
          const c = parseClause(rest);
          if (['url', 'title', 'text', 'count', 'value', 'checked', 'unchecked', 'visible', 'hidden', 'focused'].includes(c.what)) {
            const o = await observe(page, c, session, false);
            push(o.ok ? 'holds' : 'fails', o.ok ? `holds now — ${o.actual}` : `does not hold now — ${o.actual} (may after earlier steps)`);
            continue;
          }
        } catch { /* 파싱 실패는 apply 가 말한다 */ }
      }
      push('observe', unknownSince ? `unknown until step ${unknownSince}` : '—');
      continue;
    }
    push('observe', '—');
  }
  return out;
}

const VERDICT_MARK: Record<Verdict, (s: string) => string> = {
  already: chalk.dim, will: chalk.cyan, found: chalk.green, cached: chalk.green, ambiguous: chalk.yellow,
  missing: chalk.red, unknown: chalk.dim, holds: chalk.green, fails: chalk.yellow, observe: chalk.dim, ref: chalk.red,
};

// ------------------------------------------------------------ commands

export function registerPlanCommands(program: Command): void {
  program
    .command('plan')
    .description('Dry-run a plan file (or a recipe) against the current page and cache: for each step, whether its target is found · ambiguous · missing · unknown until an earlier navigation. Nothing is executed')
    .argument('<file-or-recipe>', 'A .json plan file, or a recipe name')
    .argument('[vars...]', 'NAME=value')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'JSON')
    .action(async (what: string, varArgs: string[], opts) => {
      try {
        const { values } = recipes.parseRunVars(varArgs);
        const session = opts.session ?? store.getActive();
        if (!session) throw new NoActiveSession();
        const { browser } = await connect(session);
        const page = await getActivePage(browser);
        const plan = loadTarget(what, recipes.domainOf(page.url()));
        const judgments = await judgePlan(plan, page, session, values);
        browser.disconnect();
        if (opts.json) { console.log(JSON.stringify({ plan: plan.name, steps: judgments }, null, 2)); return; }
        info(`plan ${plan.name} — ${plan.steps.length} steps, judged against ${page.url()} (nothing executed)`);
        for (const j of judgments) {
          console.log(` ${String(j.index).padStart(2)} ${j.argv.join(' ').padEnd(48).slice(0, 48)} ${VERDICT_MARK[j.verdict](j.note)}`);
        }
        const bad = judgments.filter(j => j.verdict === 'missing' || j.verdict === 'ambiguous' || j.verdict === 'ref');
        if (bad.length) info(`${bad.length} step(s) look wrong now: ${bad.map(j => j.index).join(', ')} — steps after a navigation are judged from cache only`);
        else success('nothing looks wrong now — steps after a navigation are judged from cache only');
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('apply')
    .description('Run a plan file (or a recipe) step by step in this session — or in every session of a --group at once, with a session × step matrix. Stops at the first failing step (per session)')
    .argument('<file-or-recipe>', 'A .json plan file, or a recipe name')
    .argument('[vars...]', 'NAME=value for each $NAME')
    .option('-s, --session <name>', 'Session name (default: the plan\'s "session", else the active one)')
    .option('--group <name>', 'Apply to every session in this group (the plan\'s "group" if omitted here)')
    .option('--from <step>', 'Start at this step (1-based)', (v: string) => Number(v))
    .option('--no-start-url', 'Do not navigate to the plan\'s startUrl first')
    .option('--json', 'JSON report')
    .action(async (what: string, varArgs: string[], opts) => {
      try {
        const { values, rest } = recipes.parseRunVars(varArgs);
        if (rest.length) throw new Error(`unexpected argument(s): ${rest.join(' ')} — vars are NAME=value`);
        const plan = loadTarget(what);
        const steps = plan.steps.map(s => recipes.expandVars(s, values));
        const mask = masker(plan.vars.map(v => values[v] ?? process.env[v]).filter((v): v is string => !!v));
        const group = opts.group ?? plan.group;
        const sessions = group
          ? store.list().filter(s => s.group === group).map(s => s.name)
          : [opts.session ?? plan.session ?? store.getActive()].filter((s): s is string => !!s);
        if (sessions.length === 0) throw new Error(group ? `no sessions in group '${group}'` : 'no session — -s <name>, "session" in the plan, or `tirno attach`');
        const withStart = opts.startUrl !== false && plan.startUrl && (opts.from ?? 1) === 1 ? [['nav', plan.startUrl], ...steps] : steps;
        const from = withStart === steps ? (opts.from ?? 1) : 1;
        const show = (argv: string[]) => mask(argv.join(' '));

        if (sessions.length === 1) {
          const session = sessions[0];
          const report = await runSteps(withStart, session, {
            from,
            onStep: (i, argv, r) => console.log(` ${String(withStart === steps ? i : i - 1).padStart(2)}  tirno ${show(argv)}   ${r.ok ? chalk.dim(mask(r.summary)) : chalk.red('✗')}`),
          });
          if (opts.json) { console.log(JSON.stringify({ plan: plan.name, session, ...report }, null, 2)); }
          if (!report.ok) {
            const f = report.results[report.results.length - 1];
            const stepNo = withStart === steps ? f.index : f.index - 1;
            throw new TirnoError(`apply ${plan.name}: step ${stepNo} failed — ${mask(f.result.summary)}\n  fix, then \`tirno apply ${what} --from ${Math.max(1, stepNo)}\``, 'recipe_step_failed', { step: stepNo, argv: f.argv, code: f.result.code });
          }
          success(`apply ${plan.name}: ${report.results.length} step${report.results.length === 1 ? '' : 's'} ok in ${session}`);
          return;
        }

        // 그룹 — 동시에, 매트릭스로
        info(`apply ${plan.name} to ${sessions.length} sessions (${group}) — ${withStart.length} steps each`);
        const reports = await Promise.all(sessions.map(async session => ({ session, report: await runSteps(withStart, session, { from }) })));
        if (opts.json) { console.log(JSON.stringify({ plan: plan.name, sessions: reports }, null, 2)); }
        else {
          const headers = ['SESSION', ...withStart.map((_, i) => String(withStart === steps ? i + 1 : i)), 'RESULT'];
          const rows = reports.map(({ session, report }) => [
            session,
            ...withStart.map((_, i) => { const r = report.results[i]; return !r ? chalk.dim('·') : r.result.ok ? chalk.green('✓') : chalk.red('✗'); }),
            report.ok ? chalk.green('ok') : chalk.red(`step ${withStart === steps ? report.failedStep : (report.failedStep ?? 1) - 1}: ${mask(report.results[report.results.length - 1].result.summary).slice(0, 60)}`),
          ]);
          console.log(formatTable(headers, rows));
        }
        const failed = reports.filter(r => !r.report.ok);
        if (failed.length) throw new TirnoError(`${failed.length}/${sessions.length} sessions failed: ${failed.map(f => f.session).join(', ')}`, 'broadcast_partial', { failed: failed.map(f => f.session), total: sessions.length });
        success(`apply ${plan.name}: ok in all ${sessions.length} sessions`);
      } catch (e) {
        fail(e);
      }
    });
}
