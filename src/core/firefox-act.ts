/**
 * Firefox 세션의 조작 — snapshot · @ref · click · fill · type · press · wait-for.
 *
 * WebDriver BiDi 에는 Chrome 의 접근성 트리(`Accessibility.getFullAXTree`)와 `backendNodeId`
 * 에 해당하는 것이 없다. 그래서 역할과 이름은 페이지 안에서 HTML 의 암묵 역할과 ARIA 속성으로
 * 계산하고(브라우저 자신의 계산이 아니라 Chrome 과 다를 수 있다), 노드는 BiDi 의 `sharedId`
 * 로 가리킨다. 입력은 `input.performActions` 의 실제 포인터·키 동작이다.
 *
 * 클릭 전 가림 판정과 거절 문구는 Chrome 경로의 것(`HIT_TEST` · `refuseClick`)을 그대로 쓴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from './session-store.js';
import { openFirefoxPage, type FirefoxPage, type RemoteValue } from './firefox.js';
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
    return meta.engine === 'firefox' ? meta : null;
  } catch {
    return null;
  }
}

export function plain(rv: RemoteValue): unknown {
  switch (rv.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'number': return typeof rv.value === 'number' ? rv.value : Number(rv.value);
    case 'array': return (rv.value as RemoteValue[]).map(plain);
    case 'object': return Object.fromEntries((rv.value as Array<[string | RemoteValue, RemoteValue]>)
      .map(([k, v]) => [typeof k === 'string' ? k : String(plain(k)), plain(v)]));
    case 'node': return { sharedId: rv.sharedId };
    default: return rv.value;
  }
}

/** 역할·이름·깊이·노드. 보이지 않거나 역할이 없는 요소는 건너뛰고 그 자식을 본다 */
const ITEMS = `function () {
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
}`;

interface Item { role: string; name: string; depth: number; node: { sharedId: string } }

async function items(page: FirefoxPage): Promise<Item[]> {
  const rows = plain(await page.call(ITEMS)) as Array<[string, string, number, { sharedId: string }]>;
  return rows.map(([role, name, depth, node]) => ({ role, name, depth, node }));
}

function refFile(session: string): string {
  return path.join(underRoot('refs'), `${session}.firefox.json`);
}

async function withPage<T>(meta: store.SessionMetadata, fn: (page: FirefoxPage) => Promise<T>): Promise<T> {
  const { page, browser } = await openFirefoxPage(meta);
  try {
    return await fn(page);
  } finally {
    browser.disconnect();
  }
}

export async function firefoxSnapshot(meta: store.SessionMetadata): Promise<string> {
  return withPage(meta, async page => {
    const list = await items(page);
    fs.mkdirSync(path.dirname(refFile(meta.name)), { recursive: true });
    fs.writeFileSync(refFile(meta.name), JSON.stringify({ url: page.url(), refs: list.map(i => i.node.sharedId) }));
    return list.map((i, n) => `@${n + 1}  ${'  '.repeat(i.depth)}${i.role}${i.name ? ` ${JSON.stringify(i.name)}` : ''}`).join('\n');
  });
}

type Resolved = { kind: 'node'; node: { sharedId: string }; label: string } | { kind: 'coords'; x: number; y: number; label: string };

function matchName(name: string, wanted: string | undefined, exact: boolean): boolean {
  if (wanted === undefined) return true;
  return exact ? name === wanted : name.toLowerCase().includes(wanted.toLowerCase());
}

async function byRoleName(page: FirefoxPage, word: string, wanted: string | undefined, exact: boolean): Promise<Item[]> {
  const role = axRole(word);
  const hits = (await items(page)).filter(i => i.role === role && matchName(i.name, wanted, exact));
  const exactHits = hits.filter(i => i.name === wanted);
  return hits.length > 1 && exactHits.length === 1 ? exactHits : hits;
}

/** 셀렉터 하나. light DOM 에서 못 찾으면 열린 shadow root 안까지 */
const QUERY = `function (sel) {
  const deep = (root) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const h = deep(el.shadowRoot); if (h) return h; }
    return null;
  };
  return deep(document);
}`;

async function resolve(page: FirefoxPage, meta: store.SessionMetadata, target: string, name: string | undefined, exact: boolean): Promise<Resolved> {
  const coords = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(target);
  if (coords) return { kind: 'coords', x: Number(coords[1]), y: Number(coords[2]), label: target };
  const ref = /^@(\d+)$/.exec(target);
  if (ref) {
    let stored: { refs: string[] } | null = null;
    try { stored = JSON.parse(fs.readFileSync(refFile(meta.name), 'utf8')) as { refs: string[] }; } catch { /* 아직 안 찍었다 */ }
    const sharedId = stored?.refs[Number(ref[1]) - 1];
    if (!sharedId) throw new TirnoError(`No ${target} in this session — run "tirno snapshot" first`, 'unknown_ref', { ref: target });
    return { kind: 'node', node: { sharedId }, label: target };
  }
  if (isRoleWord(target)) {
    const label = name === undefined ? target : `${target} ${JSON.stringify(name)}`;
    const hits = await byRoleName(page, target, name, exact);
    if (hits.length === 0) throw new TirnoError(`No ${label} on the page — "tirno snapshot" lists what is there`, 'target_not_found', { role: target, name });
    if (hits.length > 1) {
      throw new TirnoError(`${label} matches ${hits.length} elements: ${hits.slice(0, 5).map(h => `${h.role} ${JSON.stringify(h.name)}`).join(', ')} — use --exact or @N`,
        'ambiguous_target', { candidates: hits.map(h => ({ role: h.role, name: h.name })) });
    }
    return { kind: 'node', node: hits[0].node, label };
  }
  const found = await page.call(QUERY, [{ type: 'string', value: target }]);
  if (found.type !== 'node' || !found.sharedId) throw new TirnoError(`No element matches ${target}`, 'target_not_found', { selector: target });
  return { kind: 'node', node: { sharedId: found.sharedId }, label: target };
}

/** 낡은 sharedId — 페이지가 그 노드를 버렸거나 다른 문서로 갔다 */
async function onNode<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof TirnoError && e.data?.['bidiError'] === 'no such node') {
      throw new TirnoError(`${label} is no longer in the document — the page re-rendered or navigated. Run "tirno snapshot" and use the new ref`, 'stale_ref', { ref: label });
    }
    throw e;
  }
}

function pointerClick(x: number, y: number, dbl: boolean): unknown[] {
  const press = [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }];
  return [{
    type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' }, ...press, ...(dbl ? press : [])],
  }];
}

export async function firefoxClick(meta: store.SessionMetadata, target: string, name: string | undefined,
  opts: { exact?: boolean; dbl?: boolean; synthetic?: boolean }): Promise<string> {
  return withPage(meta, async page => {
    const t = await resolve(page, meta, target, name, !!opts.exact);
    if (t.kind === 'coords') {
      await page.perform(pointerClick(t.x, t.y, !!opts.dbl));
      return `Clicked at (${t.x}, ${t.y})`;
    }
    await onNode(t.label, async () => {
      if (opts.synthetic) {
        await page.call(`function (dbl) { this.scrollIntoView({ block: 'center', inline: 'center' }); this.focus?.(); this.click(); if (dbl) this.click(); }`,
          [{ type: 'boolean', value: !!opts.dbl }], t.node);
        return;
      }
      const h = plain(await page.call(HIT_TEST, [], t.node)) as HitTest;
      const refusal = refuseClick(t.label, h);
      if (refusal) throw new TirnoError(refusal, 'error', { relation: h.relation });
      await page.perform(pointerClick(h.x, h.y, !!opts.dbl));
    });
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

function keyActions(steps: Array<{ type: 'keyDown' | 'keyUp'; value: string }>): unknown[] {
  return [{ type: 'key', id: 'keyboard', actions: steps }];
}

function typingSteps(text: string): Array<{ type: 'keyDown' | 'keyUp'; value: string }> {
  const steps: Array<{ type: 'keyDown' | 'keyUp'; value: string }> = [];
  for (const ch of text) {
    const shift = SHIFTED.has(ch);
    if (shift) steps.push({ type: 'keyDown', value: KEYS['Shift'] });
    steps.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch });
    if (shift) steps.push({ type: 'keyUp', value: KEYS['Shift'] });
  }
  return steps;
}

export async function firefoxType(meta: store.SessionMetadata, text: string): Promise<void> {
  await withPage(meta, page => page.perform(keyActions(typingSteps(text))));
}

export async function firefoxPress(meta: store.SessionMetadata, key: string): Promise<void> {
  const combo = parseKeyCombo(key);
  const value = [...combo.key].length === 1 ? combo.key : KEYS[combo.key];
  if (!value) throw new TirnoError(`Unknown key "${combo.key}"`, 'error');
  const mods = combo.modifiers.map(m => KEYS[m]);
  await withPage(meta, page => page.perform(keyActions([
    ...mods.map(v => ({ type: 'keyDown' as const, value: v })),
    { type: 'keyDown', value }, { type: 'keyUp', value },
    ...mods.reverse().map(v => ({ type: 'keyUp' as const, value: v })),
  ])));
}

const FOCUS_AND_SELECT = `function () {
  this.scrollIntoView({ block: 'center', inline: 'center' });
  this.focus();
  if (typeof this.select === 'function') this.select();
  else if (this.isContentEditable) {
    const r = document.createRange(); r.selectNodeContents(this);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
}`;

export async function firefoxFill(meta: store.SessionMetadata, target: string, name: string | undefined, value: string,
  opts: { exact?: boolean; verify?: boolean }): Promise<string> {
  return withPage(meta, async page => {
    const t = await resolve(page, meta, target, name, !!opts.exact);
    if (t.kind === 'coords') throw new TirnoError('fill takes an element, not coordinates', 'error');
    await onNode(t.label, async () => {
      await page.call(FOCUS_AND_SELECT, [], t.node);
      await page.perform(keyActions(value === '' ? [{ type: 'keyDown', value: KEYS['Backspace'] }, { type: 'keyUp', value: KEYS['Backspace'] }] : typingSteps(value)));
      if (opts.verify === false) return;
      const now = plain(await page.call(`function () { return 'value' in this ? this.value : this.textContent; }`, [], t.node));
      if (now !== value) {
        throw new TirnoError(`${t.label} holds ${JSON.stringify(now)} after typing ${JSON.stringify(value)} — the field rewrote or refused the input (--no-verify skips this check)`,
          'error', { expected: value, actual: now });
      }
    });
    return t.label;
  });
}

export async function firefoxWaitFor(meta: store.SessionMetadata, form: { selector?: string; name?: string; text?: string[]; exact?: boolean }, timeout: number): Promise<string> {
  return withPage(meta, async page => {
    let label: string;
    let present: () => Promise<boolean>;
    if (form.text) {
      label = `Text visible: ${form.text.join(' | ')}`;
      present = async () => plain(await page.call(`function (texts) { const b = document.body?.innerText ?? ''; return texts.some(t => b.includes(t)); }`,
        [{ type: 'array', value: form.text!.map(t => ({ type: 'string', value: t })) }])) === true;
    } else if (form.selector && isRoleWord(form.selector)) {
      label = `Visible: ${form.name === undefined ? form.selector : `${form.selector} ${JSON.stringify(form.name)}`}`;
      present = async () => (await byRoleName(page, form.selector!, form.name, !!form.exact)).length > 0;
    } else if (form.selector) {
      label = `Selector visible: ${form.selector}`;
      present = async () => (await page.call(QUERY, [{ type: 'string', value: form.selector }])).type === 'node';
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
