/**
 * `expect` 와 `ensure` — 상태를 선언한다 (#210).
 *
 * `expect` 는 관측만 한다: 맞으면 exit 0, 틀리면 exit 1 + `expect_failed` 에 기대/실측.
 * `ensure` 는 멱등이다: 이미 그 상태면 `already`, 아니면 만들고 `expect` 로 되읽어 `ensured`,
 * 그래도 아니면 `failed`. 같은 줄을 두 번 쳐도 안전하다 — 에이전트의 재시도 루프가
 * "같은 줄을 다시 친다" 로 줄어든다.
 *
 * 문법은 자연어에 가깝게 둔다: `expect url ~ /dash` · `expect text "Saved" within 5s` ·
 * `ensure textbox "Email" = me@x` · `ensure checkbox "Remember" checked`.
 */
import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage, getInteractivePage } from '../cdp/page-resolver.js';
import { success, info, fail } from '../output/formatter.js';
import { TirnoError } from '../util/errors.js';
import { resolveTarget, findByRoleName, axRole, isRoleWord } from '../cdp/target.js';
import { clickByRef, fillByRef } from '../cdp/dom-actions.js';
import { READ_FIELD_STATE, type FieldState } from '../cdp/fill-verify.js';
import { judgeNavigation } from '../cdp/nav-verdict.js';
import type { Page } from '../cdp/page.js';
import { actWithDelta, printDelta } from './delta-output.js';
import { runAudit } from './a11y.js';
import { IMPACT_ORDER, type Impact } from '../a11y/audit.js';

// ------------------------------------------------------------ 문법

export interface Duration { ms: number; raw: string }

/** `5s` · `500ms` · `2m` · `10` (ms) */
export function parseDuration(s: string): Duration | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  return { ms: unit === 's' ? n * 1000 : unit === 'm' ? n * 60000 : n, raw: s };
}

export type Comparator = '=' | '~' | '>=' | '<=' | '>' | '<' | '!=' | 'contains';

/**
 * 기호와 낱말 둘 다 받는다 — 셸에서 `~` 는 홈으로 풀리고 `>=` 는 리다이렉트라 따옴표가
 * 필요하다. `matches` · `ge` 같은 낱말은 따옴표 없이 친다.
 */
const COMPARATOR_WORDS: Record<string, Comparator> = {
  '=': '=', '==': '=', 'is': '=', 'equals': '=',
  '!=': '!=', 'ne': '!=', 'not': '!=',
  '~': '~', 'matches': '~', 'like': '~',
  'contains': 'contains', 'has': 'contains',
  '>=': '>=', 'ge': '>=', '<=': '<=', 'le': '<=', '>': '>', 'gt': '>', '<': '<', 'lt': '<',
};
const COMPARATORS = new Set(Object.keys(COMPARATOR_WORDS));

/** 뒤에서 `within <dur>` 를 떼어낸다. 뒤 낱말이 기간이 아니면 `within` 은 그냥 낱말이다. */
export function splitWithin(args: string[]): { args: string[]; within?: Duration } {
  const i = args.findIndex((a, idx) => a === 'within' && idx === args.length - 2);
  if (i === -1) return { args };
  const d = parseDuration(args[i + 1]);
  if (!d) return { args };
  return { args: args.slice(0, i), within: d };
}

export interface Clause {
  what: string;
  /** role+name 대상이 있는 절이면 */
  role?: string;
  name?: string;
  op?: Comparator;
  value?: string;
  within?: Duration;
  /** 원문 — 출력용 */
  text: string;
}

/**
 * `<what> [role name] [op] [value] [within d]` 를 절로. `what` 이 정하는 모양:
 *   url [~] <v> · title [~] <v> · text <v> · count <selector> <op> <n> ·
 *   value <role> <name> [=] <v> · checked|unchecked <role> <name> ·
 *   visible|hidden <role> <name> | text <v> · focused <role> <name>
 */
export function parseClause(argv: string[]): Clause {
  const { args, within } = splitWithin(argv);
  const [what, ...rest] = args;
  if (!what) throw new Error('what to expect? url · title · text · count · value · checked · unchecked · visible · hidden · focused');
  const text = argv.join(' ');
  const c: Clause = { what, within, text };
  // role 뒤의 이름은 비워도 된다 — 그 role 이 페이지에 하나뿐일 때. 비교자나 within 이
  // 바로 뒤에 오면 이름이 없는 것이다.
  const takeTarget = () => {
    if (rest.length < 1 || !isRoleWord(rest[0])) throw new Error(`${what} needs <role> ["<name>"], e.g. ${what} textbox "Email"`);
    c.role = rest.shift();
    if (rest.length && !COMPARATORS.has(rest[0])) c.name = rest.shift();
  };
  switch (what) {
    case 'url': case 'title': {
      if (rest.length === 0) throw new Error(`${what} needs a value: ${what} [~] <value>`);
      if (COMPARATORS.has(rest[0])) c.op = norm(rest.shift()!);
      c.value = rest.join(' ');
      if (!c.op) c.op = '=';
      break;
    }
    case 'text': {
      if (rest.length === 0) throw new Error('text needs the text to look for');
      c.op = 'contains';
      c.value = rest.join(' ');
      break;
    }
    case 'count': {
      if (rest.length < 3) throw new Error('count needs <selector> <op> <n>, e.g. count tr.row >= 3');
      c.value = rest[0];
      c.op = norm(rest[1]);
      c.name = rest.slice(2).join(' ');           // n 을 name 자리에 둔다
      break;
    }
    case 'value': {
      takeTarget();
      if (rest.length && COMPARATORS.has(rest[0])) c.op = norm(rest.shift()!);
      else c.op = '=';
      c.value = rest.join(' ');
      break;
    }
    case 'checked': case 'unchecked': case 'focused': {
      takeTarget();
      break;
    }
    case 'visible': case 'hidden': {
      if (rest[0] === 'text') { rest.shift(); c.op = 'contains'; c.value = rest.join(' '); }
      else takeTarget();
      break;
    }
    case 'a11y': {
      // a11y clean [rules a,b] · a11y <impact> <op> <n>
      if (rest[0] === 'clean') {
        rest.shift(); c.value = 'clean';
        const kw: string | undefined = rest[0];
        if (kw === 'rules') { rest.shift(); c.name = rest.shift(); }
      }
      else if (rest.length >= 3 && COMPARATORS.has(rest[1])) { c.value = rest[0]; c.op = norm(rest[1]); c.name = rest[2]; }
      else throw new Error('a11y needs: a11y clean [rules names,alt] · a11y serious le 0');
      break;
    }
    default:
      throw new Error(`Unknown expectation "${what}" — url · title · text · count · value · checked · unchecked · visible · hidden · focused`);
  }
  return c;
}

function norm(op: string): Comparator {
  return COMPARATOR_WORDS[op];
}

export function compare(op: Comparator, actual: string | number, expected: string): boolean {
  switch (op) {
    case '=': return String(actual) === expected;
    case '!=': return String(actual) !== expected;
    case '~': return new RegExp(expected).test(String(actual));
    case 'contains': return String(actual).includes(expected);
    case '>=': return Number(actual) >= Number(expected);
    case '<=': return Number(actual) <= Number(expected);
    case '>': return Number(actual) > Number(expected);
    case '<': return Number(actual) < Number(expected);
  }
}

// ------------------------------------------------------------ 관측

export interface Observation { ok: boolean; actual: string; expected: string }

async function fieldState(page: Page, backendNodeId: number): Promise<FieldState> {
  const cdp = await page.createCDPSession();
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    const r = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId!, functionDeclaration: READ_FIELD_STATE, returnByValue: true });
    return r.result.value as FieldState;
  } finally {
    await cdp.detach();
  }
}

async function checkedState(page: Page, backendNodeId: number): Promise<boolean | null> {
  const cdp = await page.createCDPSession();
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    const r = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId!,
      functionDeclaration: 'function(){ if (typeof this.checked === "boolean") return this.checked; const a = this.getAttribute("aria-checked"); return a === null ? null : a === "true"; }',
      returnByValue: true,
    });
    return r.result.value as boolean | null;
  } finally {
    await cdp.detach();
  }
}

/** 한 번 관측한다. 대상이 없는 것도 관측이다(`actual: (not found)`). */
async function observe(page: Page, c: Clause, session: string, exact: boolean): Promise<Observation> {
  const expected = c.value ?? (c.what === 'checked' ? 'checked' : c.what === 'unchecked' ? 'unchecked' : c.what);
  const target = async () => resolveTarget(page, c.role!, c.name, { session, exact });
  switch (c.what) {
    case 'url': {
      const actual = page.url();
      return { ok: compare(c.op!, actual, expected), actual, expected: `${c.op} ${expected}` };
    }
    case 'title': {
      const actual = await page.title();
      return { ok: compare(c.op!, actual, expected), actual, expected: `${c.op} ${expected}` };
    }
    case 'text': {
      const body = await page.evaluate<string>('document.body ? document.body.innerText : ""').catch(() => '');
      const ok = body.includes(expected);
      return { ok, actual: ok ? `found ${JSON.stringify(expected)}` : `not in page text (${body.length} chars)`, expected: JSON.stringify(expected) };
    }
    case 'count': {
      const n = await page.evaluate<number>(`document.querySelectorAll(${JSON.stringify(c.value)}).length`);
      return { ok: compare(c.op!, n, c.name!), actual: String(n), expected: `${c.op} ${c.name}` };
    }
    case 'value': {
      let t;
      try { t = await target(); } catch (e) { return { ok: false, actual: `(${(e as Error).message})`, expected: `${c.op} ${JSON.stringify(expected)}` }; }
      if (t.kind === 'coords') throw new Error('value needs an element');
      const s = await fieldState(page, t.backendNodeId);
      const actual = s.value ?? '';
      // select 는 value 나 보이는 라벨 어느 쪽으로 말해도 맞다 — 사람은 라벨을 본다
      const ok = compare(c.op!, actual, expected) || (s.selectedLabel != null && compare(c.op!, s.selectedLabel, expected));
      const shown = s.selectedLabel != null && s.selectedLabel !== actual ? `${JSON.stringify(s.selectedLabel)} (value ${JSON.stringify(actual)})` : JSON.stringify(actual);
      return { ok, actual: shown, expected: `${c.op} ${JSON.stringify(expected)}` };
    }
    case 'checked': case 'unchecked': {
      let t;
      try { t = await target(); } catch (e) { return { ok: false, actual: `(${(e as Error).message})`, expected }; }
      if (t.kind === 'coords') throw new Error(`${c.what} needs an element`);
      const v = await checkedState(page, t.backendNodeId);
      const actual = v === null ? 'not checkable' : v ? 'checked' : 'unchecked';
      return { ok: actual === expected, actual, expected };
    }
    case 'focused': {
      let t;
      try { t = await target(); } catch (e) { return { ok: false, actual: `(${(e as Error).message})`, expected: 'focused' }; }
      if (t.kind === 'coords') throw new Error('focused needs an element');
      const s = await fieldState(page, t.backendNodeId);
      return { ok: s.focused, actual: s.focused ? 'focused' : 'not focused', expected: 'focused' };
    }
    case 'a11y': {
      const rules = c.value === 'clean' && c.name ? c.name.split(',') : undefined;
      const r = await runAudit(page, session, { rules });
      if (c.value === 'clean') {
        const ok = r.violations.length === 0;
        const worst = r.violations[0];
        return { ok, actual: ok ? 'clean' : `${r.violations.length} violation(s) — worst ${worst.impact} ${worst.rule}${worst.ref ? ' ' + worst.ref : ''}: ${worst.message}`, expected: `clean${rules ? ` (${rules.join(',')})` : ''}` };
      }
      const impact = c.value as Impact;
      if (!IMPACT_ORDER.includes(impact)) throw new Error(`a11y impact must be one of ${IMPACT_ORDER.join(' · ')}`);
      const n = r.violations.filter(v => IMPACT_ORDER.indexOf(v.impact) <= IMPACT_ORDER.indexOf(impact)).length;
      return { ok: compare(c.op!, n, c.name!), actual: `${n} at ${impact} or worse`, expected: `${impact} ${c.op} ${c.name}` };
    }
    case 'visible': case 'hidden': {
      const want = c.what === 'visible';
      if (c.value !== undefined) {
        const body = await page.evaluate<string>('document.body ? document.body.innerText : ""').catch(() => '');
        const present = body.includes(c.value);
        return { ok: present === want, actual: present ? 'visible' : 'hidden', expected: c.what };
      }
      const cdp = await page.createCDPSession();
      let found: number;
      try { found = (await findByRoleName(cdp, axRole(c.role!), c.name, exact)).length; } finally { await cdp.detach(); }
      const present = found > 0;
      return { ok: present === want, actual: present ? `visible (${found})` : 'hidden', expected: c.what };
    }
  }
  throw new Error(`cannot observe ${c.what}`);
}

/** `within` 이 있으면 그 시간 안에 맞을 때까지 200ms 마다 다시 본다 */
async function observeWithin(page: Page, c: Clause, session: string, exact: boolean, defaultMs: number): Promise<Observation> {
  const deadline = Date.now() + (c.within?.ms ?? defaultMs);
  for (;;) {
    const o = await observe(page, c, session, exact);
    if (o.ok || Date.now() >= deadline) return o;
    await new Promise(r => setTimeout(r, 200));
  }
}

function describeTarget(c: Clause): string {
  return c.role ? (c.name === undefined ? c.role : `${c.role} ${JSON.stringify(c.name)}`) : '';
}

// ------------------------------------------------------------ 명령

export function registerDeclareCommands(program: Command): void {
  program
    .command('expect')
    .description('Assert page state; exit 1 with code expect_failed (and expected/actual) when it does not hold. Forms: `url [~] <v>` · `title [~] <v>` · `text <v>` · `count <sel> <op> <n>` · `value <role> "<name>" [=] <v>` · `checked|unchecked <role> "<name>"` · `visible|hidden <role> "<name>" | text <v>` · `focused <role> "<name>"` · `a11y clean [rules a,b]` · `a11y serious le 0`. Append `within 5s` to keep checking until then (default 1s)')
    .argument('<clause...>', 'e.g. url matches /dash · text Saved within 5s · count tr.row ge 3 · value textbox Email is me@x. Comparators: = is · != ne · ~ matches · contains · >= ge · <= le · > gt · < lt (words need no shell quoting)')
    .option('-s, --session <name>', 'Session name')
    .option('--exact', 'Match accessible names exactly')
    .action(async (argv: string[], opts) => {
      try {
        const c = parseClause(argv);
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);
        const o = await observeWithin(page, c, meta.name, !!opts.exact, 1000);
        browser.disconnect();
        const head = `expect ${c.what}${describeTarget(c) ? ' ' + describeTarget(c) : ''}`;
        if (!o.ok) {
          throw new TirnoError(`${head}: expected ${o.expected}, page says ${o.actual}${c.within ? ` (after ${c.within.raw})` : ''}`, 'expect_failed',
            { what: c.what, expected: o.expected, actual: o.actual });
        }
        success(`${head} ${o.expected} — ${o.actual}`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('ensure')
    .description('Make the page state so, idempotently: `already` if it holds, otherwise act and read it back (`ensured`), else exit 1. Forms: `url <v>` (navigates) · `value|textbox|combobox… <role> "<name>" = <v>` (fills) · `checked|unchecked <role> "<name>"` (clicks) · `focused <role> "<name>"` · `visible <role> "<name>" | text <v>` (waits, default 10s). Append `within 10s` to change the wait')
    .argument('<clause...>', 'e.g. textbox Email = me@x · checkbox Remember checked · checkbox checked (when only one) · url https://app/dash · visible text Welcome')
    .option('-s, --session <name>', 'Session name')
    .option('--exact', 'Match accessible names exactly')
    .option('--no-delta', 'Do not report what changed when an action was needed')
    .action(async (argv: string[], opts) => {
      try {
        const c = normalizeEnsure(argv);
        const { browser, meta } = await connect(opts.session);
        const page = await getInteractivePage(browser);
        const exact = !!opts.exact;
        const head = `ensure ${c.what}${describeTarget(c) ? ' ' + describeTarget(c) : ''}`;

        // 이미 그 상태인가 — visible 류는 기다리는 것 자체가 행동이므로 여기서 기다린다
        const isWait = c.what === 'visible' || c.what === 'hidden';
        const first = await observeWithin(page, c, meta.name, exact, isWait ? (c.within?.ms ?? 10000) : 0);
        if (first.ok) {
          browser.disconnect();
          success(`${head}: already — ${first.actual}`);
          return;
        }
        if (isWait) {
          throw new TirnoError(`${head}: still ${first.actual} after ${c.within?.raw ?? '10s'}`, 'expect_failed', { what: c.what, expected: first.expected, actual: first.actual });
        }

        // 만든다
        const { delta } = await actWithDelta(page, opts, () => act(page, c, meta.name, exact));
        const after = await observeWithin(page, c, meta.name, exact, c.within?.ms ?? 1000);
        browser.disconnect();
        if (!after.ok) {
          throw new TirnoError(`${head}: acted, but page says ${after.actual} (expected ${after.expected})`, 'expect_failed',
            { what: c.what, expected: after.expected, actual: after.actual });
        }
        success(`${head}: ensured — ${after.actual}`);
        printDelta(delta);
      } catch (e) {
        fail(e);
      }
    });
}

/** `ensure textbox "Email" = v` 는 `ensure value textbox "Email" = v` 의 줄임 */
export function normalizeEnsure(argv: string[]): Clause {
  if (argv.length && isRoleWord(argv[0])) {
    // role 로 시작 — 끝이 checked/unchecked/focused 면 그것, 아니면 value
    const withinIdx = argv.indexOf('within');
    const body = withinIdx === -1 ? argv : argv.slice(0, withinIdx);
    const w = withinIdx === -1 ? [] : argv.slice(withinIdx);
    const tail = body[body.length - 1];
    if ((body.length === 2 || body.length === 3) && (tail === 'checked' || tail === 'unchecked' || tail === 'focused')) {
      return parseClause([tail, ...body.slice(0, -1), ...w]);
    }
    return parseClause(['value', ...argv]);
  }
  return parseClause(argv);
}

/** 그 상태를 만드는 행동 하나 */
async function act(page: Page, c: Clause, session: string, exact: boolean): Promise<void> {
  switch (c.what) {
    case 'url': {
      const r = await page.goto(c.value!, { waitUntil: 'domcontentloaded' });
      const v = judgeNavigation({ url: c.value!, status: r?.status() ?? 0, finalUrl: page.url(), elapsed: 0, strict: false });
      if (v.level === 'fail') throw new Error(v.note ?? 'navigation failed');
      if (v.level === 'warn') info(v.note!);
      return;
    }
    case 'value': {
      const t = await resolveTarget(page, c.role!, c.name, { session, exact });
      if (t.kind === 'coords') throw new Error('value needs an element');
      const s = await fieldState(page, t.backendNodeId);
      if (s.tag === 'select') {
        // combobox 는 타이핑이 아니라 고르기다 — 보이는 라벨 또는 value 로
        const cdp = await page.createCDPSession();
        try {
          const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: t.backendNodeId });
          const r = await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId!, returnByValue: true,
            functionDeclaration: `function(want){ const o = [...this.options].find(o => o.value === want || o.label === want || o.text.trim() === want); if (!o) return false; this.value = o.value; this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); return true; }`,
            arguments: [{ value: c.value }],
          });
          if (!r.result.value) throw new TirnoError(`no option ${JSON.stringify(c.value)} in ${t.label}`, 'target_not_found', { option: c.value });
        } finally {
          await cdp.detach();
        }
        return;
      }
      await fillByRef(page, t.backendNodeId, c.value!, { label: t.label, verify: true });
      return;
    }
    case 'checked': case 'unchecked': {
      const t = await resolveTarget(page, c.role!, c.name, { session, exact });
      if (t.kind === 'coords') throw new Error(`${c.what} needs an element`);
      await clickByRef(page, t.backendNodeId, { label: t.label });
      return;
    }
    case 'focused': {
      const t = await resolveTarget(page, c.role!, c.name, { session, exact });
      if (t.kind === 'coords') throw new Error('focused needs an element');
      await page.session.send('DOM.focus', { backendNodeId: t.backendNodeId });
      return;
    }
    default:
      throw new Error(`ensure cannot make "${c.what}" — it is observe-only; use expect`);
  }
}

