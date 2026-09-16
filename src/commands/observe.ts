/**
 * 목적별 관측 — `forms` · `links` · `table` · `read` · `explain` · `watch` (#213).
 *
 * `snapshot` 하나가 모든 것을 낸다. 목적을 말하면 토큰이 반으로 줄고, "이 요소가 왜 안
 * 눌리나" 는 한 명령으로 답한다. 전부 페이지 안 한 번의 순회거나 이미 있는 판정(hit-test ·
 * field state · 캐시)의 조합이다.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, info, fail, formatTable } from '../output/formatter.js';
import { emitPageLines, resolveMaxOutput, boundariesEnabled } from '../output/page-content.js';
import { intArg } from '../util/parsers.js';
import { resolveTarget } from '../cdp/target.js';
import { HIT_TEST, type HitTest } from '../cdp/click-target.js';
import { READ_FIELD_STATE, type FieldState } from '../cdp/fill-verify.js';
import { getElementInfo } from '../cdp/element-info.js';
import * as visualCache from '../core/visual-cache.js';
import * as refStore from '../core/ref-store.js';
import type { Page } from '../cdp/page.js';

const OUTPUT_FLAGS = [
  ['--max-output <chars>', 'Cut the output at this many characters (whole lines) and say how much was cut. Also TIRNO_MAX_OUTPUT'],
  ['--content-boundaries', 'Wrap page-authored text in begin/end markers with a per-run nonce. Also TIRNO_CONTENT_BOUNDARIES=1'],
] as const;

// ------------------------------------------------------------ forms

const FORMS = `(scope) => {
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return null;
  const labelOf = (el) => {
    const al = el.getAttribute('aria-label'); if (al) return al.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(n => n.textContent.trim()).join(' '); if (t) return t; }
    if (el.labels && el.labels[0]) return el.labels[0].textContent.trim().replace(/\\s+/g, ' ');
    const ph = el.getAttribute('placeholder'); if (ph) return ph;
    const t = el.getAttribute('title'); if (t) return t;
    return '';
  };
  const out = [];
  for (const el of root.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"]')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;
    const role = el.getAttribute('role') || (type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : tag === 'select' ? 'combobox' : type === 'file' ? 'file' : 'textbox');
    let value = '';
    if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch') value = (el.checked ?? el.getAttribute('aria-checked') === 'true') ? 'checked' : 'unchecked';
    else if (tag === 'select') value = el.selectedOptions[0] ? (el.selectedOptions[0].label || el.selectedOptions[0].text).trim() : '';
    else if (type === 'password') value = el.value ? '•'.repeat(Math.min(el.value.length, 8)) : '';
    else if (type === 'file') value = el.files && el.files.length ? el.files.length + ' file(s)' : '';
    else value = el.isContentEditable ? (el.textContent || '').trim().slice(0, 60) : String(el.value ?? '').slice(0, 60);
    const options = tag === 'select' ? [...el.options].map(o => (o.label || o.text).trim()).slice(0, 12) : undefined;
    let invalid = false; try { invalid = el.matches(':invalid'); } catch (e) {}
    out.push({ label: labelOf(el), role, type, name: el.getAttribute('name') || '', id: el.id || '', value, required: !!el.required || el.getAttribute('aria-required') === 'true', disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', readonly: !!el.readOnly, invalid, options });
  }
  return out;
}`;

interface FormField { label: string; role: string; type: string; name: string; id: string; value: string; required: boolean; disabled: boolean; readonly: boolean; invalid: boolean; options?: string[] }

// ------------------------------------------------------------ links

const LINKS = `(scope) => {
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return null;
  const out = [];
  for (const a of root.querySelectorAll('a[href], [role="link"]')) {
    const cs = getComputedStyle(a);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const href = a.href || a.getAttribute('href') || '';
    const name = (a.getAttribute('aria-label') || a.getAttribute('title') || (a.textContent || '').trim().replace(/\\s+/g, ' ') || (a.querySelector('img[alt]') || {}).alt || '').slice(0, 60);
    let external = false; try { external = new URL(href, location.href).host !== location.host; } catch (e) {}
    out.push({ name, href, external, target: a.getAttribute('target') || '' });
  }
  return out;
}`;

interface LinkRow { name: string; href: string; external: boolean; target: string }

// ------------------------------------------------------------ table

const TABLE = `(sel) => {
  const t = document.querySelector(sel);
  if (!t) return null;
  const rows = [...t.querySelectorAll('tr')].filter(r => r.closest('table') === t);
  if (!rows.length) return { headers: [], rows: [] };
  const text = (c) => (c.textContent || '').trim().replace(/\\s+/g, ' ');
  const first = rows[0];
  const headerCells = [...first.querySelectorAll('th')];
  const headers = headerCells.length && headerCells.length === first.children.length ? headerCells.map(text) : [];
  const body = headers.length ? rows.slice(1) : rows;
  const data = body.map(r => [...r.children].map(text));
  return { headers, rows: data };
}`;

// ------------------------------------------------------------ read

/**
 * 본문만 — readability 규칙의 작은 부분집합. article/main/[role=main] 이 있으면 그것,
 * 없으면 <p> 글자 수가 가장 많은 블록. nav·aside·footer·header 는 뺀다.
 */
const READ = `() => {
  const skip = (el) => !!el.closest('nav, aside, footer, header, [role="navigation"], [role="banner"], [role="contentinfo"], script, style, noscript, [aria-hidden="true"]');
  let root = document.querySelector('article, main, [role="main"]');
  if (!root) {
    let best = null, bestScore = 0;
    for (const el of document.body.querySelectorAll('div, section, td')) {
      if (skip(el)) continue;
      let score = 0;
      for (const p of el.querySelectorAll(':scope > p, :scope > * > p')) score += (p.textContent || '').trim().length;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    root = best || document.body;
  }
  const lines = [];
  const title = (document.title || '').trim();
  if (title) lines.push('# ' + title, '');
  let firstHeading = true;
  const walk = (el) => {
    for (const n of el.children) {
      if (skip(n)) continue;
      const tag = n.tagName.toLowerCase();
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const t = (n.innerText || n.textContent || '').trim().replace(/[ \\t]+/g, ' ');
      if (/^h[1-6]$/.test(tag)) {
        // 첫 헤딩이 제목과 같으면 한 번만
        if (t && !(firstHeading && t === title)) lines.push('#'.repeat(Number(tag[1])) + ' ' + t, '');
        firstHeading = false; continue;
      }
      if (tag === 'p' || tag === 'blockquote' || tag === 'pre') { if (t) lines.push(tag === 'blockquote' ? '> ' + t : t, ''); continue; }
      if (tag === 'li') { if (t) lines.push('- ' + t.split('\\n')[0]); continue; }
      if (tag === 'ul' || tag === 'ol') { walk(n); lines.push(''); continue; }
      if (tag === 'img') { const alt = n.getAttribute('alt'); if (alt) lines.push('[image: ' + alt + ']'); continue; }
      if (tag === 'table') { lines.push('[table]'); continue; }
      walk(n);
    }
  };
  walk(root);
  const out = []; for (const l of lines) { if (l === '' && out[out.length - 1] === '') continue; out.push(l); }
  return { lines: out, from: root === document.body ? 'body' : (root.tagName.toLowerCase() + (root.id ? '#' + root.id : '')) };
}`;

// ------------------------------------------------------------ explain

const EXPLAIN = `function(){
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const attrs = {}; for (const a of el.attributes) if (/^(id|class|name|type|href|role|aria-[a-z-]+|data-testid|disabled|tabindex|placeholder|title)$/.test(a.name)) attrs[a.name] = a.value.slice(0, 80);
  return {
    tag: el.tagName.toLowerCase(), attrs,
    box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
    display: cs.display, visibility: cs.visibility, opacity: cs.opacity, pointerEvents: cs.pointerEvents,
    focusable: el.tabIndex >= 0 || ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName),
    text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
  };
}`;

interface ExplainInfo { tag: string; attrs: Record<string, string>; box: { x: number; y: number; w: number; h: number }; inViewport: boolean; display: string; visibility: string; opacity: string; pointerEvents: string; focusable: boolean; text: string }

async function callOn(page: Page, backendNodeId: number, fn: string): Promise<unknown> {
  const cdp = await page.createCDPSession();
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    const r = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId!, functionDeclaration: fn, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  } finally {
    await cdp.detach();
  }
}

// ------------------------------------------------------------ commands

export function registerObserveCommands(program: Command): void {
  program
    .command('forms')
    .description('Form fields as a table: label · role · current value · required · disabled · invalid (and a select\'s options). Passwords are masked')
    .option('-s, --session <name>', 'Session name')
    .option('--selector <css>', 'Only this subtree')
    .option('--json', 'JSON')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const fields = await page.evaluate<FormField[] | null>(`(${FORMS})(${JSON.stringify(opts.selector ?? null)})`);
        browser.disconnect();
        if (!fields) throw new Error(`no element for ${opts.selector}`);
        if (opts.json) { console.log(JSON.stringify(fields, null, 2)); return; }
        if (!fields.length) { info('no form fields'); return; }
        console.log(formatTable(['LABEL', 'ROLE', 'VALUE', 'FLAGS', 'SELECTOR'], fields.map(f => [
          f.label || chalk.dim('(no label)'), f.role === 'textbox' && f.type !== 'text' && f.type !== 'textarea' ? `textbox/${f.type}` : f.role,
          (f.value || chalk.dim('(empty)')) + (f.options ? chalk.dim(` ⟨${f.options.join(' | ')}⟩`) : ''),
          [f.required && 'required', f.disabled && 'disabled', f.readonly && 'readonly', f.invalid && chalk.red('invalid')].filter(Boolean).join(' ') || '-',
          f.id ? `#${f.id}` : f.name ? `[name=${f.name}]` : '-',
        ])));
        info(`${fields.length} field(s) — \`tirno ensure <role> "<label>" = …\` sets one`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('links')
    .description('Links as a table: name · href · external')
    .option('-s, --session <name>', 'Session name')
    .option('--selector <css>', 'Only this subtree')
    .option('--external', 'Only links to other hosts')
    .option('--json', 'JSON')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        let links = await page.evaluate<LinkRow[] | null>(`(${LINKS})(${JSON.stringify(opts.selector ?? null)})`);
        browser.disconnect();
        if (!links) throw new Error(`no element for ${opts.selector}`);
        if (opts.external) links = links.filter(l => l.external);
        if (opts.json) { console.log(JSON.stringify(links, null, 2)); return; }
        if (!links.length) { info('no links'); return; }
        console.log(formatTable(['NAME', 'HREF', ''], links.map(l => [l.name || chalk.dim('(no name)'), l.href.length > 70 ? l.href.slice(0, 67) + '…' : l.href, [l.external && 'external', l.target && `target=${l.target}`].filter(Boolean).join(' ')])));
        info(`${links.length} link(s) — \`tirno click link "<name>"\``);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('table')
    .description('A <table> as data — headers from <th>, one row per <tr>')
    .argument('<selector>', 'CSS selector of the table')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Rows as objects keyed by header (arrays when there are no headers)')
    .option('--csv', 'CSV')
    .action(async (selector: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const t = await page.evaluate<{ headers: string[]; rows: string[][] } | null>(`(${TABLE})(${JSON.stringify(selector)})`);
        browser.disconnect();
        if (!t) throw new Error(`no table for ${selector}`);
        if (opts.json) {
          console.log(JSON.stringify(t.headers.length ? t.rows.map(r => Object.fromEntries(t.headers.map((h, i) => [h, r[i] ?? '']))) : t.rows, null, 2));
          return;
        }
        if (opts.csv) {
          const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
          for (const r of [t.headers.length ? t.headers : [], ...t.rows]) if (r.length) console.log(r.map(esc).join(','));
          return;
        }
        if (!t.rows.length) { info('empty table'); return; }
        const width = Math.max(t.headers.length, ...t.rows.map(r => r.length));
        console.log(formatTable(t.headers.length ? t.headers : Array.from({ length: width }, (_, i) => `#${i + 1}`), t.rows.map(r => Array.from({ length: width }, (_, i) => (r[i] ?? '').slice(0, 40)))));
        info(`${t.rows.length} row(s) — --json for data, --csv for a file`);
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('read')
    .description('The readable body of the page as plain text — headings, paragraphs, lists. Nav, headers, footers and asides are dropped')
    .option('-s, --session <name>', 'Session name')
    .option(OUTPUT_FLAGS[0][0], OUTPUT_FLAGS[0][1], intArg)
    .option(OUTPUT_FLAGS[1][0], OUTPUT_FLAGS[1][1])
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const r = await page.evaluate<{ lines: string[]; from: string }>(`(${READ})()`);
        browser.disconnect();
        emitPageLines(r.lines, { maxOutput: resolveMaxOutput(opts.maxOutput), boundaries: boundariesEnabled(opts.contentBoundaries), narrowHint: 'Use `tirno snapshot --selector` for one part', label: 'page text' });
        info(chalk.dim(`from <${r.from}> · ${r.lines.length} lines`));
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('explain')
    .description('Everything known about one element: role · name · tag · selector · box · visible · covered (by what) · enabled · focusable · field state · cache history. Why a click would or would not land')
    .argument('<target>', '@N, CSS selector, or a role word followed by the name')
    .argument('[name]', 'Accessible name when <target> is a role word')
    .option('-s, --session <name>', 'Session name')
    .option('--exact', 'Exact name match')
    .option('--json', 'JSON')
    .action(async (target: string, name: string | undefined, opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);
        const t = await resolveTarget(page, target, name, { session: meta.name, staleOk: true, exact: !!opts.exact });
        if (t.kind === 'coords') throw new Error('explain takes an element, not coordinates');
        const cdp = await page.createCDPSession();
        let ax: { role: string; name: string; props: Record<string, unknown> } = { role: '?', name: '', props: {} };
        try {
          const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: t.backendNodeId, fetchRelatives: false });
          const n = nodes[0];
          if (n) ax = { role: String(n.role?.value ?? '?'), name: String(n.name?.value ?? ''), props: Object.fromEntries((n.properties ?? []).map(p => [p.name, p.value?.value])) };
        } catch { /* a11y 트리에 없는 노드 */ }
        const elInfo = await getElementInfo(cdp, t.backendNodeId).catch(() => ({}));
        await cdp.detach();
        const dom = await callOn(page, t.backendNodeId, EXPLAIN) as ExplainInfo | null;
        const hit = await callOn(page, t.backendNodeId, HIT_TEST) as HitTest;
        const field = ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'slider'].includes(ax.role)
          ? await callOn(page, t.backendNodeId, READ_FIELD_STATE) as FieldState : null;
        // 캐시 이력 — 이 URL 의 항목에서 같은 role+이름
        const entry = visualCache.lookup(page.url());
        // 이름이 없는 요소는 role 만으로는 여럿이 맞는다 — 그때는 selector 가 같아야 같은 것이다
        const mySel = (elInfo as { selector?: string }).selector;
        const history = entry ? entry.refs.filter(w => {
          const a = w.channels.a11y;
          if (!a || a.role !== ax.role) return false;
          return ax.name ? a.name === ax.name : (!!mySel && w.channels.dom?.selector === mySel);
        }).map(w => ({ id: w.refId ?? w.id, capturedAt: entry.capturedAt, selector: w.channels.dom?.selector, bbox: w.channels.visual?.bbox })) : [];
        const store = refStore.load(meta.name);
        const ref = Object.entries(store.refs).find(([, v]) => v.backendId === t.backendNodeId)?.[0];
        browser.disconnect();

        const report = { target: t.label, ref: ref ? `@${ref} (generation ${store.generation})` : null, role: ax.role, name: ax.name, dom, selector: (elInfo as { selector?: string }).selector ?? null, hit, field, props: ax.props, history };
        if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }
        const line = (k: string, v: string) => console.log(`  ${chalk.dim(k.padEnd(11))} ${v}`);
        success(`${t.label} — ${ax.role}${ax.name ? ` ${JSON.stringify(ax.name)}` : ''}${ref ? `  (@${ref}, generation ${store.generation})` : ''}`);
        if (dom) {
          line('element', `<${dom.tag}${Object.entries(dom.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>`);
          line('selector', (elInfo as { selector?: string }).selector ?? chalk.dim('none stable (no id / data-testid / aria-label / name) — use role + name'));
          line('box', `${dom.box.w}×${dom.box.h} at (${dom.box.x},${dom.box.y})${dom.inViewport ? '' : chalk.yellow('  outside the viewport')}`);
          line('visible', dom.display === 'none' ? chalk.red('display:none') : dom.visibility === 'hidden' ? chalk.red('visibility:hidden') : dom.opacity === '0' ? chalk.yellow('opacity 0') : 'yes');
        }
        const clickable = hit.relation === 'self' || hit.relation === 'inside' || hit.relation === 'ancestor';
        line('click', clickable ? chalk.green(`would land (${hit.relation})`) : chalk.red(hit.relation === 'covered' ? `covered by ${hit.hit}` : hit.relation));
        line('enabled', ax.props['disabled'] === true ? chalk.red('disabled') : 'yes');
        line('focusable', dom?.focusable ? 'yes' : 'no');
        if (dom?.pointerEvents === 'none') line('pointer', chalk.yellow('pointer-events: none — clicks fall through to the parent'));
        if (field) line('field', `value ${JSON.stringify(field.value)}${field.readOnly ? ' · readonly' : ''}${field.disabled ? ' · disabled' : ''}${field.maxLength >= 0 ? ` · maxlength ${field.maxLength}` : ''}${field.focused ? ' · focused' : ''}`);
        const states = Object.entries(ax.props).filter(([k, v]) => ['checked', 'expanded', 'selected', 'required', 'invalid', 'readonly', 'level'].includes(k) && v !== false && v !== 'false').map(([k, v]) => v === true ? k : `${k}=${String(v)}`);
        if (states.length) line('state', states.join(' · '));
        line('cache', history.length ? `seen as ${history.map(h => h.id).join(', ')} in the entry captured ${history[0].capturedAt.slice(0, 16).replace('T', ' ')}` : chalk.dim('not in the cache for this URL'));
      } catch (e) {
        fail(e);
      }
    });

  program
    .command('watch')
    .description('Stream page events as NDJSON until Ctrl-C or --for: console, page errors, network, navigation, dialogs, DOM mutation counts. For watching what happens asynchronously')
    .option('-s, --session <name>', 'Session name')
    .option('--console', 'console messages and page errors')
    .option('--network', 'requests and responses (method, url, status)')
    .option('--dom', 'DOM mutations per 500ms (added/removed nodes)')
    .option('--all', 'everything (default when no filter is given)')
    .option('--for <duration>', 'Stop after this long, e.g. 10s, 2m')
    .action(async (opts) => {
      try {
        const all = opts.all || (!opts.console && !opts.network && !opts.dom);
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const emit = (type: string, data: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), type, ...data }));
        emit('watch', { url: page.url(), filters: all ? ['console', 'network', 'dom', 'navigation', 'dialog'] : [opts.console && 'console', opts.network && 'network', opts.dom && 'dom'].filter(Boolean) });
        if (all || opts.console) {
          page.on('console', m => emit('console', { level: m.type(), text: m.text(), location: m.location().url ? `${m.location().url}:${m.location().lineNumber}` : undefined }));
          page.on('pageerror', e => emit('pageerror', { message: e.message.split('\n')[0] }));
        }
        if (all || opts.network) {
          page.session.on('Network.requestWillBeSent', e => emit('request', { id: e.requestId, method: e.request.method, url: e.request.url, type: e.type }));
          page.session.on('Network.responseReceived', e => emit('response', { id: e.requestId, status: e.response.status, url: e.response.url, mime: e.response.mimeType }));
          page.session.on('Network.loadingFailed', e => emit('failed', { id: e.requestId, error: e.errorText }));
        }
        page.on('navigated', url => emit('navigation', { url }));
        page.on('dialog', d => { emit('dialog', { kind: d.type, message: d.message, action: 'accepted' }); d.accept().catch(() => {}); });
        let domTimer: ReturnType<typeof setInterval> | null = null;
        if (all || opts.dom) {
          await page.evaluate(`(() => { if (window.__tirno_mut) return; const c = window.__tirno_mut = { added: 0, removed: 0 }; new MutationObserver(ms => { for (const m of ms) { c.added += m.addedNodes.length; c.removed += m.removedNodes.length; } }).observe(document, { childList: true, subtree: true }); })()`).catch(() => {});
          domTimer = setInterval(async () => {
            const c = await page.evaluate<{ added: number; removed: number } | null>('(() => { const c = window.__tirno_mut; if (!c) return null; const r = { added: c.added, removed: c.removed }; c.added = 0; c.removed = 0; return r; })()').catch(() => null);
            if (c && (c.added || c.removed)) emit('dom', c);
          }, 500);
        }
        let ended = false;
        const stop = (reason?: string) => { if (ended) return; ended = true; if (domTimer) clearInterval(domTimer); emit('end', reason ? { reason } : {}); browser.disconnect(); process.exit(0); };
        process.on('SIGINT', () => stop());
        process.on('SIGTERM', () => stop());
        if (opts.for) {
          const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(opts.for);
          if (!m) throw new Error('--for takes 10s · 500ms · 2m');
          const ms = Number(m[1]) * (m[2] === 'm' ? 60000 : m[2] === 'ms' ? 1 : 1000);
          setTimeout(() => stop(), ms);
        }
        // 연결이 끊기면(Chrome 종료) 끝
        browser.connection.onclose = () => stop('connection closed');
        await new Promise(() => {});
      } catch (e) {
        fail(e);
      }
    });
}
