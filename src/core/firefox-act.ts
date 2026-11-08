/**
 * BiDi 세션(Firefox · Safari)의 조작 — snapshot · @ref · click · fill · type · press · wait-for.
 *
 * WebDriver BiDi 에는 Chrome 의 접근성 트리(`Accessibility.getFullAXTree`)와 `backendNodeId`
 * 에 해당하는 것이 없다. 그래서 역할과 이름은 페이지 안에서 HTML 의 암묵 역할과 ARIA 속성으로
 * 계산하고(브라우저 자신의 계산이 아니라 Chrome 과 다를 수 있다), 입력은 `input.performActions`
 * 의 실제 포인터·키 동작으로 보낸다.
 *
 * 노드는 페이지 안의 등록부(`window[Symbol.for('tirno.refs')]`, WeakRef 배열)로 가리킨다.
 * BiDi 의 노드 참조(`sharedId`)와 `script.callFunction` 의 인자는 Safari(Technology Preview
 * 256)에서 동작하지 않아(실측: 인자가 undefined 로 오고, 노드는 classic 요소 참조 모양으로
 * 돌아온다), 페이지에서 할 일은 인자를 JSON 리터럴로 넣은 식 하나로 보낸다. 등록부는 페이지
 * 전역에 있으므로 페이지 스크립트가 볼 수 있고, 이동하면 사라진다 — 그 뒤의 @ref 는 낡은 것이다.
 *
 * 클릭 전 가림 판정과 거절 문구는 Chrome 경로의 것(`HIT_TEST` · `refuseClick`)을 그대로 쓴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from './session-store.js';
import { openBidiPage, type FirefoxPage } from './firefox.js';
import { underRoot } from './paths.js';
import { TirnoError } from '../util/errors.js';
import { axRole, isRoleWord } from '../cdp/target.js';
import { HIT_TEST, refuseClick, type HitTest } from '../cdp/click-target.js';
import { parseKeyCombo } from '../cdp/keys.js';

export function firefoxSession(session?: string): store.SessionMetadata | null {
  const name = session ?? store.getActive();
  if (!name) return null;
  try {
    const meta = store.get(name);
    return meta.engine ? meta : null;
  } catch {
    return null;
  }
}

/** 페이지 안 공용 함수. 역할·이름 계산, 등록부, 셀렉터 */
const LIB = `
  const REFS = Symbol.for('tirno.refs'), PICK = Symbol.for('tirno.pick');
  const text = (el) => (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 100);
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit && explicit.trim()) return explicit.trim().split(/\\s+/)[0];
    const t = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'hidden') return null;
      return { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
        button: 'button', submit: 'button', reset: 'button', image: 'button' }[ty] || 'textbox';
    }
    if (t === 'a' || t === 'area') return el.hasAttribute('href') ? 'link' : null;
    if (t === 'img') return el.getAttribute('alt') === '' ? null : 'image';
    if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'section') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
    return { button: 'button', textarea: 'textbox', option: 'option', nav: 'navigation', main: 'main', dialog: 'dialog',
      ul: 'list', ol: 'list', li: 'listitem', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', form: 'form',
      header: 'banner', footer: 'contentinfo', aside: 'complementary', summary: 'button', p: 'paragraph',
      article: 'article' }[t] || null;
  };
  const NAMED_BY_CONTENT = new Set(['button', 'link', 'heading', 'option', 'cell', 'columnheader', 'listitem', 'tab',
    'menuitem', 'checkbox', 'radio', 'paragraph', 'switch', 'treeitem']);
  const nameOf = (el, role) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(text).join(' ').trim();
      if (t) return t;
    }
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return label.trim();
    if (el.labels && el.labels.length) return [...el.labels].map(text).join(' ').trim();
    const t = el.tagName.toLowerCase();
    if (t === 'img') return el.getAttribute('alt') || '';
    if (t === 'input' && ['submit', 'button', 'reset'].includes(el.type)) return el.value || (el.type === 'submit' ? 'Submit' : '');
    if (NAMED_BY_CONTENT.has(role)) return text(el);
    return el.getAttribute('placeholder') || el.getAttribute('title') || '';
  };
  const hidden = (el) => el.hidden || el.getAttribute('aria-hidden') === 'true'
    || (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true }));
  const items = () => {
    const out = [['RootWebArea', document.title, 0, document.documentElement]];
    const walk = (parent, depth) => {
      for (const el of parent.children) {
        if (hidden(el)) continue;
        const role = roleOf(el);
        if (role) out.push([role, nameOf(el, role), depth, el]);
        walk(el, role ? depth + 1 : depth);
        if (el.shadowRoot) walk(el.shadowRoot, role ? depth + 1 : depth);
      }
    };
    if (document.body) walk(document.body, 1);
    return out;
  };
  const deepQuery = (sel) => {
    const deep = (root) => {
      const hit = root.querySelector(sel);
      if (hit) return hit;
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const h = deep(el.shadowRoot); if (h) return h; }
      return null;
    };
    return deep(document);
  };
  const match = (role, wanted, exact) => {
    const hits = items().filter(([r, n]) => r === role && (wanted === null || (exact ? n === wanted : n.toLowerCase().includes(wanted.toLowerCase()))));
    const exactHits = hits.filter(([, n]) => n === wanted);
    return hits.length > 1 && exactHits.length === 1 ? exactHits : hits;
  };
  const target = (loc) => (loc.ref === undefined ? window[PICK] : (window[REFS] || [])[loc.ref])?.deref();
`;

/** 인자를 JSON 리터럴로 넣어 페이지에서 부른다. 결과는 JSON 으로 돌아온다 */
function inPage<T>(page: FirefoxPage, body: string, ...args: unknown[]): Promise<T> {
  const params = args.map((_, i) => `a${i}`).join(', ');
  const literals = args.map(a => a === undefined ? 'undefined' : JSON.stringify(a)).join(', ');
  return page.evaluate(`((${params}) => { ${LIB} ${body} })(${literals})`) as Promise<T>;
}

function refFile(session: string): string {
  return path.join(underRoot('refs'), `${session}.firefox.json`);
}

async function withPage<T>(meta: store.SessionMetadata, fn: (page: FirefoxPage) => Promise<T>): Promise<T> {
  const { page, browser } = await openBidiPage(meta);
  try {
    return await fn(page);
  } finally {
    browser.disconnect();
  }
}

export async function firefoxSnapshot(meta: store.SessionMetadata): Promise<string> {
  return withPage(meta, async page => {
    const rows = await inPage<Array<[string, string, number]>>(page, `
      const list = items();
      window[REFS] = list.map(i => new WeakRef(i[3]));
      return list.map(([r, n, d]) => [r, n, d]);`);
    fs.mkdirSync(path.dirname(refFile(meta.name)), { recursive: true });
    fs.writeFileSync(refFile(meta.name), JSON.stringify({ url: page.url(), count: rows.length }));
    return rows.map(([role, name, depth], n) => `@${n + 1}  ${'  '.repeat(depth)}${role}${name ? ` ${JSON.stringify(name)}` : ''}`).join('\n');
  });
}

type Loc = { ref?: number };
type Resolved = { kind: 'node'; loc: Loc; label: string } | { kind: 'coords'; x: number; y: number; label: string };

async function resolve(page: FirefoxPage, meta: store.SessionMetadata, target: string, name: string | undefined, exact: boolean): Promise<Resolved> {
  const coords = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(target);
  if (coords) return { kind: 'coords', x: Number(coords[1]), y: Number(coords[2]), label: target };
  const ref = /^@(\d+)$/.exec(target);
  if (ref) {
    let count = 0;
    try { count = (JSON.parse(fs.readFileSync(refFile(meta.name), 'utf8')) as { count: number }).count; } catch { /* 아직 안 찍었다 */ }
    const n = Number(ref[1]);
    if (n < 1 || n > count) throw new TirnoError(`No ${target} in this session — run "tirno snapshot" first`, 'unknown_ref', { ref: target });
    return { kind: 'node', loc: { ref: n - 1 }, label: target };
  }
  if (isRoleWord(target)) {
    const label = name === undefined ? target : `${target} ${JSON.stringify(name)}`;
    const hits = await inPage<Array<[string, string]>>(page, `
      const hits = match(a0, a1, a2);
      window[PICK] = hits.length === 1 ? new WeakRef(hits[0][3]) : undefined;
      return hits.map(([r, n]) => [r, n]);`, axRole(target), name ?? null, exact);
    if (hits.length === 0) throw new TirnoError(`No ${label} on the page — "tirno snapshot" lists what is there`, 'target_not_found', { role: target, name });
    if (hits.length > 1) {
      throw new TirnoError(`${label} matches ${hits.length} elements: ${hits.slice(0, 5).map(([r, n]) => `${r} ${JSON.stringify(n)}`).join(', ')} — use --exact or @N`,
        'ambiguous_target', { candidates: hits.map(([role, n]) => ({ role, name: n })) });
    }
    return { kind: 'node', loc: {}, label };
  }
  const found = await inPage<boolean>(page, `const el = deepQuery(a0); window[PICK] = el ? new WeakRef(el) : undefined; return !!el;`, target);
  if (!found) throw new TirnoError(`No element matches ${target}`, 'target_not_found', { selector: target });
  return { kind: 'node', loc: {}, label: target };
}

function pointerClick(x: number, y: number, dbl: boolean): unknown[] {
  const press = [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }];
  return [{
    type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' }, ...press, ...(dbl ? press : [])],
  }];
}

const DETACHED = `{ x: 0, y: 0, relation: 'detached', hit: null }`;

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

async function clickAt(page: FirefoxPage, x: number, y: number, dbl: boolean): Promise<void> {
  if (!page.webdriver) return page.perform(pointerClick(x, y, dbl));
  await page.classic('POST', '/actions', { actions: pointerClick(x, y, dbl) });
  await page.classic('DELETE', '/actions');
}

/** Safari — 포커스된 요소의 classic 요소 참조. 요소 키 보내기는 OS 입력기를 타지 않는다(실측) */
async function focusedElement(page: FirefoxPage): Promise<string> {
  const ref = await page.classic<Record<string, string>>('POST', '/execute/sync', { script: 'return document.activeElement || document.body', args: [] });
  return ref[ELEMENT];
}

async function sendText(page: FirefoxPage, text: string): Promise<void> {
  if (!page.webdriver) return page.perform(keyActions(typingSteps(text)));
  await page.classic('POST', `/element/${await focusedElement(page)}/value`, { text });
}

export async function firefoxClick(meta: store.SessionMetadata, target: string, name: string | undefined,
  opts: { exact?: boolean; dbl?: boolean; synthetic?: boolean }): Promise<string> {
  return withPage(meta, async page => {
    const t = await resolve(page, meta, target, name, !!opts.exact);
    if (t.kind === 'coords') {
      await clickAt(page, t.x, t.y, !!opts.dbl);
      return `Clicked at (${t.x}, ${t.y})`;
    }
    if (opts.synthetic) {
      const done = await inPage<boolean>(page, `
        const el = target(a0);
        if (!el || !el.isConnected) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' }); el.focus?.(); el.click(); if (a1) el.click();
        return true;`, t.loc, !!opts.dbl);
      if (!done) throw new TirnoError(refuseClick(t.label, { x: 0, y: 0, relation: 'detached', hit: null })!, 'stale_ref', { ref: t.label });
      return `Clicked ${t.label}`;
    }
    const h = await inPage<HitTest>(page, `const el = target(a0); return el ? (${HIT_TEST}).call(el) : ${DETACHED};`, t.loc);
    const refusal = refuseClick(t.label, h);
    if (refusal) throw new TirnoError(refusal, h.relation === 'detached' ? 'stale_ref' : 'error', { relation: h.relation });
    await clickAt(page, h.x, h.y, !!opts.dbl);
    return `Clicked ${t.label}`;
  });
}

const SHIFTED = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:"<>?');

/** WebDriver 의 키 코드 — https://w3c.github.io/webdriver/#keyboard-actions */
const KEYS: Record<string, string> = {
  Enter: '', Tab: '', Escape: '', Backspace: '', Delete: '', Insert: '',
  ArrowLeft: '', ArrowUp: '', ArrowRight: '', ArrowDown: '',
  Home: '', End: '', PageUp: '', PageDown: '', Space: ' ',
  Shift: '', Control: '', Alt: '', Meta: '',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, String.fromCharCode(0xE031 + i)])),
};

type KeyStep = { type: 'keyDown' | 'keyUp'; value: string };

function keyActions(steps: KeyStep[]): unknown[] {
  return [{ type: 'key', id: 'keyboard', actions: steps }];
}

function typingSteps(text: string): KeyStep[] {
  const steps: KeyStep[] = [];
  for (const ch of text) {
    const shift = SHIFTED.has(ch);
    if (shift) steps.push({ type: 'keyDown', value: KEYS['Shift'] });
    steps.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch });
    if (shift) steps.push({ type: 'keyUp', value: KEYS['Shift'] });
  }
  return steps;
}

export async function firefoxType(meta: store.SessionMetadata, text: string): Promise<void> {
  await withPage(meta, page => sendText(page, text));
}

export async function firefoxPress(meta: store.SessionMetadata, key: string): Promise<void> {
  const combo = parseKeyCombo(key);
  const value = [...combo.key].length === 1 ? combo.key : KEYS[combo.key];
  if (!value) throw new TirnoError(`Unknown key "${combo.key}"`, 'error');
  const mods = combo.modifiers.map(m => KEYS[m]);
  const steps: KeyStep[] = [
    ...mods.map(v => ({ type: 'keyDown' as const, value: v })),
    { type: 'keyDown', value }, { type: 'keyUp', value },
    ...[...mods].reverse().map(v => ({ type: 'keyUp' as const, value: v })),
  ];
  await withPage(meta, async page => {
    if (!page.webdriver) return page.perform(keyActions(steps));
    // 수식키 조합과 특수 키는 키 동작으로 — 요소 키 보내기로는 편집 명령(전체 선택)과 포커스
    // 이동(Tab)이 안 돈다(실측). 글자 하나만 입력기를 피해 요소 키 보내기로 간다.
    if (mods.length || value !== combo.key) {
      await page.classic('POST', '/actions', { actions: keyActions(steps) });
      await page.classic('DELETE', '/actions');
    } else {
      await sendText(page, value);
    }
  });
}

export async function firefoxFill(meta: store.SessionMetadata, target: string, name: string | undefined, value: string,
  opts: { exact?: boolean; verify?: boolean }): Promise<string> {
  return withPage(meta, async page => {
    const t = await resolve(page, meta, target, name, !!opts.exact);
    if (t.kind === 'coords') throw new TirnoError('fill takes an element, not coordinates', 'error');
    const focused = await inPage<boolean>(page, `
      const el = target(a0);
      if (!el || !el.isConnected) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (typeof el.select === 'function') el.select();
      else if (el.isContentEditable) {
        const r = document.createRange(); r.selectNodeContents(el);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
      return true;`, t.loc);
    if (!focused) throw new TirnoError(refuseClick(t.label, { x: 0, y: 0, relation: 'detached', hit: null })!, 'stale_ref', { ref: t.label });
    if (page.webdriver) {
      // 요소 키 보내기는 선택을 덮어쓰지 않고 끝에 붙인다 — 비우고 보낸다
      const el = await focusedElement(page);
      await page.classic('POST', `/element/${el}/clear`, {});
      if (value !== '') await page.classic('POST', `/element/${el}/value`, { text: value });
    } else {
      await page.perform(keyActions(value === '' ? [{ type: 'keyDown', value: KEYS['Backspace'] }, { type: 'keyUp', value: KEYS['Backspace'] }] : typingSteps(value)));
    }
    if (opts.verify === false) return t.label;
    const now = await inPage<unknown>(page, `const el = target(a0); return el ? ('value' in el ? el.value : el.textContent) : null;`, t.loc);
    if (now !== value) {
      throw new TirnoError(`${t.label} holds ${JSON.stringify(now)} after typing ${JSON.stringify(value)} — the field rewrote or refused the input (--no-verify skips this check)`,
        'error', { expected: value, actual: now });
    }
    return t.label;
  });
}

export async function firefoxWaitFor(meta: store.SessionMetadata, form: { selector?: string; name?: string; text?: string[]; exact?: boolean }, timeout: number): Promise<string> {
  return withPage(meta, async page => {
    let label: string;
    let present: () => Promise<boolean>;
    if (form.text) {
      label = `Text visible: ${form.text.join(' | ')}`;
      present = () => inPage<boolean>(page, `const b = document.body?.innerText ?? ''; return a0.some(t => b.includes(t));`, form.text);
    } else if (form.selector && isRoleWord(form.selector)) {
      label = `Visible: ${form.name === undefined ? form.selector : `${form.selector} ${JSON.stringify(form.name)}`}`;
      present = () => inPage<boolean>(page, `return match(a0, a1, a2).length > 0;`, axRole(form.selector!), form.name ?? null, !!form.exact);
    } else if (form.selector) {
      label = `Selector visible: ${form.selector}`;
      present = () => inPage<boolean>(page, `return !!deepQuery(a0);`, form.selector);
    } else {
      throw new TirnoError('Provide a selector or --text', 'error');
    }
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await present().catch(() => false)) return label;
      if (Date.now() >= deadline) throw new TirnoError(`Waiting failed: ${timeout}ms exceeded (${label.replace(/^[^:]+: /, '')})`, 'timeout');
      await new Promise(r => setTimeout(r, 200));
    }
  });
}
