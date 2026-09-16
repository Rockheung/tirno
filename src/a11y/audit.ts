/**
 * 접근성 감사 — 의존 0 (#219).
 *
 * axe-core 를 넣지 않는 이유는 둘이다. 의존 0 을 지키는 것, 그리고 재료가 이미 있는 것 —
 * `snapshot` 이 곧 접근성 트리다. 규칙은 그 트리(role · name · properties)와 DOM 한 번의
 * 순회(in-page)로 나온다. 위반마다 `@N` 을 붙여 바로 `explain @N` · `click @N` 할 수 있고,
 * 겹치는 규칙은 axe 의 이름과 WCAG 참조를 그대로 써 결과를 대조할 수 있게 한다.
 *
 * 규칙은 파일 안에 하나씩 — `RULES` 표가 정본이다.
 */
import type { CdpSession } from '../cdp/client.js';
import type { Page } from '../cdp/page.js';
import type { AXNode } from '../cdp/ax-render.js';

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';
export const IMPACT_ORDER: Impact[] = ['critical', 'serious', 'moderate', 'minor'];

export interface Violation {
  rule: string;
  impact: Impact;
  wcag: string;
  /** 있으면 `@N` 을 붙인다 */
  backendNodeId?: number;
  ref?: string;
  /** 대상의 짧은 표기 — `button` · `img "hero.png"` · `h4` */
  target: string;
  message: string;
  fix: string;
}

export interface RuleInfo { id: string; impact: Impact; wcag: string; description: string }

export const RULES: RuleInfo[] = [
  { id: 'names', impact: 'serious', wcag: '4.1.2', description: 'interactive elements (button, link, tab, menuitem…) have an accessible name' },
  { id: 'labels', impact: 'serious', wcag: '1.3.1', description: 'form controls (textbox, checkbox, radio, combobox…) have a label' },
  { id: 'alt', impact: 'serious', wcag: '1.1.1', description: 'images have alt text (alt="" marks decorative)' },
  { id: 'headings', impact: 'minor', wcag: '1.3.1', description: 'heading levels do not skip, and there is one h1' },
  { id: 'contrast', impact: 'serious', wcag: '1.4.3', description: 'text contrast ≥ 4.5:1 (≥ 3:1 for large text)' },
  { id: 'lang', impact: 'serious', wcag: '3.1.1', description: '<html lang> is set' },
  { id: 'title', impact: 'serious', wcag: '2.4.2', description: 'the document has a title' },
  { id: 'tabindex', impact: 'moderate', wcag: '2.4.3', description: 'no positive tabindex (it hijacks focus order)' },
  { id: 'aria-refs', impact: 'serious', wcag: '4.1.2', description: 'aria-labelledby / describedby / controls point at ids that exist' },
  { id: 'duplicate-id', impact: 'minor', wcag: '4.1.1', description: 'ids are unique (labels and aria refs break otherwise)' },
];

const INTERACTIVE = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'option', 'treeitem']);
const FORM = new Set(['textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox']);

function prop(n: AXNode, name: string): unknown {
  return n.properties?.find(p => p.name === name)?.value?.value;
}

// ------------------------------------------------------- AX 트리 규칙

/** role·name·properties 만으로 판정되는 규칙들 */
export function auditAxTree(nodes: AXNode[], scope: Set<number> | null): Violation[] {
  const out: Violation[] = [];
  const inScope = (n: AXNode) => !scope || (n.backendDOMNodeId !== undefined && scope.has(n.backendDOMNodeId));
  const headings: Array<{ level: number; node: AXNode }> = [];

  for (const n of nodes) {
    if (n.ignored || !inScope(n)) continue;
    const role = String(n.role?.value ?? '');
    const name = String(n.name?.value ?? '').trim();
    const base = { backendNodeId: n.backendDOMNodeId };

    if (INTERACTIVE.has(role) && !name) {
      out.push({ ...base, rule: 'names', impact: 'serious', wcag: '4.1.2', target: role,
        message: `${role} has no accessible name`, fix: 'add visible text, aria-label, or aria-labelledby' });
    }
    if (FORM.has(role) && !name) {
      out.push({ ...base, rule: 'labels', impact: 'serious', wcag: '1.3.1', target: role,
        message: `${role} has no label`, fix: '<label for=…>, aria-label, or aria-labelledby' });
    }
    if (role === 'image' && !name) {
      out.push({ ...base, rule: 'alt', impact: 'serious', wcag: '1.1.1', target: 'img',
        message: 'image has no alt text', fix: 'alt="…" describing it, or alt="" if decorative' });
    }
    if (role === 'heading') {
      const level = Number(prop(n, 'level') ?? 0);
      if (level) headings.push({ level, node: n });
    }
  }

  let prev = 0;
  for (const h of headings) {
    if (prev && h.level > prev + 1) {
      out.push({ backendNodeId: h.node.backendDOMNodeId, rule: 'headings', impact: 'minor', wcag: '1.3.1', target: `h${h.level}`,
        message: `h${h.level} follows h${prev} — level skipped`, fix: `use h${prev + 1}, or restructure` });
    }
    prev = h.level;
  }
  if (headings.length && !headings.some(h => h.level === 1) && !scope) {
    out.push({ rule: 'headings', impact: 'moderate', wcag: '1.3.1', target: 'document',
      message: `${headings.length} heading(s) but no h1`, fix: 'give the page one h1' });
  }
  return out;
}

// --------------------------------------------------------- DOM 규칙

/**
 * 페이지 안에서 한 번에 도는 규칙들 — lang · title · tabindex · aria-refs · duplicate-id ·
 * contrast. 요소는 유일한 CSS 경로로 돌려주고 밖에서 backendNodeId 로 잇는다.
 * 대비는 WCAG 공식이고, 배경은 조상을 따라 올라가며 알파를 합성한다(이미지 배경은 모른다 —
 * 그때는 판정하지 않는다).
 */
const DOM_AUDIT = `(scopeSelector) => {
  const out = [];
  const root = scopeSelector ? document.querySelector(scopeSelector) : document;
  if (!root) return { error: 'scope not found' };
  const inScope = (el) => root === document || root.contains(el);
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id && /^[A-Za-z][\\w-]*$/.test(n.id) && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const sibs = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      parts.unshift(s);
    }
    return parts.join(' > ') || 'html';
  };
  const desc = (el) => {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (t ? ' "' + (t.length > 30 ? t.slice(0, 30) + '…' : t) + '"' : '');
  };
  if (!scopeSelector) {
    const lang = (document.documentElement.getAttribute('lang') || '').trim();
    if (!lang) out.push({ rule: 'lang', target: 'html', message: '<html> has no lang attribute', fix: '<html lang="ko"> (or the page language)' });
    if (!(document.title || '').trim()) out.push({ rule: 'title', target: 'document', message: 'document has no title', fix: '<title>…</title>' });
  }
  for (const el of root.querySelectorAll('[tabindex]')) {
    const v = parseInt(el.getAttribute('tabindex'), 10);
    if (v > 0) out.push({ rule: 'tabindex', path: path(el), target: desc(el), message: 'tabindex=' + v + ' overrides the natural focus order', fix: 'use tabindex="0" and DOM order' });
  }
  for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
    for (const el of root.querySelectorAll('[' + attr + ']')) {
      const missing = (el.getAttribute(attr) || '').split(/\\s+/).filter(id => id && !document.getElementById(id));
      if (missing.length) out.push({ rule: 'aria-refs', path: path(el), target: desc(el), message: attr + ' points at missing id(s): ' + missing.join(', '), fix: 'add the element with that id, or fix the reference' });
    }
  }
  const seen = new Map();
  for (const el of root.querySelectorAll('[id]')) { const id = el.id; if (!id) continue; seen.set(id, (seen.get(id) || 0) + 1); }
  for (const [id, n] of seen) if (n > 1) {
    const first = root.querySelector('[id="' + id.replace(/"/g, '\\\\"') + '"]');
    out.push({ rule: 'duplicate-id', path: first ? path(first) : undefined, target: '#' + id, message: 'id "' + id + '" appears ' + n + ' times', fix: 'ids must be unique' });
  }
  // 대비
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ''); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { acc = acc ? blend(acc, c) : c; if (acc.a >= 1 || c.a >= 1) return acc; }
    }
    return acc ? blend(acc, { r: 255, g: 255, b: 255, a: 1 }) : { r: 255, g: 255, b: 255, a: 1 };
  };
  const walker = document.createTreeWalker(root === document ? document.body : root, NodeFilter.SHOW_TEXT);
  const done = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.nodeValue || !t.nodeValue.trim()) continue;
    const el = t.parentElement;
    if (!el || done.has(el) || !inScope(el)) continue;
    done.add(el);
    if (el.closest('script,style,noscript,template,[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const fg = parse(cs.color); const bg = bgOf(el);
    if (!fg || !bg) continue;
    const f = fg.a < 1 ? blend(fg, bg) : fg;
    const l1 = lum(f), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) out.push({ rule: 'contrast', path: path(el), target: desc(el),
      message: ratio.toFixed(2) + ':1 (needs ' + need + ':1) — ' + cs.color + ' on rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
      fix: 'darken the text or lighten the background' });
  }
  return { violations: out };
}`;

interface DomFinding { rule: string; path?: string; target: string; message: string; fix: string }

export async function auditDom(page: Page, cdp: CdpSession, scopeSelector: string | null): Promise<Violation[]> {
  const res = await page.evaluate<{ violations?: DomFinding[]; error?: string }>(`(${DOM_AUDIT})(${JSON.stringify(scopeSelector)})`);
  if (res.error) throw new Error(res.error);
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const out: Violation[] = [];
  for (const f of res.violations ?? []) {
    const info = RULES.find(r => r.id === f.rule)!;
    let backendNodeId: number | undefined;
    if (f.path) {
      try {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: f.path });
        if (nodeId) backendNodeId = (await cdp.send('DOM.describeNode', { nodeId })).node.backendNodeId;
      } catch { /* 경로가 못 맞으면 ref 없이 낸다 */ }
    }
    out.push({ rule: f.rule, impact: info.impact, wcag: info.wcag, target: f.target, message: f.message, fix: f.fix, ...(backendNodeId ? { backendNodeId } : {}) });
  }
  return out;
}

export interface AuditResult {
  violations: Violation[];
  counts: Record<Impact, number>;
  rules: string[];
  nodes: number;
  ms: number;
}

export function summarize(violations: Violation[]): Record<Impact, number> {
  const counts: Record<Impact, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) counts[v.impact]++;
  return counts;
}

export function sortViolations(vs: Violation[]): Violation[] {
  return [...vs].sort((a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) || a.rule.localeCompare(b.rule));
}
