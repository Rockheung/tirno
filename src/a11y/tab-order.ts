/**
 * 실제로 Tab 을 눌러 가며 포커스 순서를 기록한다 (#219).
 *
 * 정적 분석(axe)이 구조적으로 못 하는 것이다 — 포커스가 어디로 가는지는 브라우저가 키를
 * 받아야 안다. 갇힘(같은 자리에 머묾) · 보이지 않는 포커스(요소가 화면 밖이거나 포커스
 * 링이 없음) · 이름 없는 정거장을 잡는다.
 */
import type { Page } from '../cdp/page.js';

export interface TabStop {
  index: number;
  /** `textbox "Search"` 꼴 */
  desc: string;
  role: string;
  name: string;
  /** 요소가 뷰포트 안에 있고 크기가 있나 */
  onScreen: boolean;
  /** :focus-visible 이고 outline 이나 box-shadow 가 있나 */
  ringVisible: boolean;
  problems: string[];
}

export interface TabOrderResult {
  stops: TabStop[];
  /** 같은 자리에 3번 머문 지점 */
  trapAt: number | null;
  /** body 로 돌아와 한 바퀴를 돌았나 */
  wrapped: boolean;
  problems: number;
}

const DESCRIBE_FOCUS = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { body: true };
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') || ({a: el.hasAttribute('href') ? 'link' : 'a', button:'button', input:(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':el.type==='submit'||el.type==='button'?'button':'textbox'), textarea:'textbox', select:'combobox', summary:'button'})[tag] || tag;
  const labelled = el.getAttribute('aria-labelledby') ? [...el.getAttribute('aria-labelledby').split(/\\s+/)].map(id => document.getElementById(id)).filter(Boolean).map(n => n.textContent.trim()).join(' ') : '';
  const lab = el.labels && el.labels[0] ? el.labels[0].textContent.trim() : '';
  const name = (el.getAttribute('aria-label') || labelled || lab || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || (el.value && el.type !== 'password' && (el.type === 'submit' || el.type === 'button') ? el.value : '') || (el.textContent || '')).trim().replace(/\\s+/g, ' ').slice(0, 40);
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && cs.visibility !== 'hidden';
  const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
  let fv = false; try { fv = el.matches(':focus-visible'); } catch (e) {}
  const ti = parseInt(el.getAttribute('tabindex') || '0', 10);
  const order = [...document.querySelectorAll('*')].indexOf(el);
  return { body: false, role, name, onScreen, ringVisible: fv ? ring : ring, key: path(el), tabindex: ti > 0 ? ti : 0, order };
  function path(n) { const p = []; for (; n && n.nodeType === 1; n = n.parentElement) { const s = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0; p.unshift(n.tagName + s); } return p.join('/'); }
})()`;

interface FocusInfo { body: boolean; role?: string; name?: string; onScreen?: boolean; ringVisible?: boolean; key?: string; tabindex?: number; order?: number }

export async function walkTabOrder(page: Page, opts: { max?: number } = {}): Promise<TabOrderResult> {
  const max = opts.max ?? 60;
  // Chrome 의 순차 포커스 시작점은 마지막 포커스·클릭 자리에 남아 그 뒤부터 이어 간다 —
  // blur 도, 선택 범위도, 임시 앵커도 문서 맨 앞으로 되돌리지 못했다(실측). 그리고 body 는
  // 문서당 한 번만 들른다(headless 실측: 두 번째 바퀴부터는 끝에서 바로 첫 요소로 간다).
  // 그래서 시작점에 기대지 않는다: 어디서 시작하든 **한 바퀴**(같은 요소를 다시 만날 때까지)
  // 를 모으고, 사람이 새 페이지에서 보는 순서(양수 tabindex 오름차순 → 문서 순)로 돌린다.
  await page.evaluate('(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); })()').catch(() => {});

  const seen = new Map<string, TabStop & { tabindex: number; order: number }>();
  const cycle: string[] = [];
  let trapAt: number | null = null;
  let sawBody = false;
  let lastKey: string | null = null, repeat = 0;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate<FocusInfo>(DESCRIBE_FOCUS);
    if (f.body) { sawBody = true; lastKey = null; repeat = 0; continue; }
    const key = f.key ?? '';
    if (key === lastKey) {
      repeat++;
      if (repeat >= 2) { trapAt = cycle.length; break; }   // 같은 자리 3번 — 갇힘
      continue;
    }
    repeat = 0; lastKey = key;
    if (seen.has(key)) break;                               // 한 바퀴 돌았다
    const problems: string[] = [];
    if (!f.name) problems.push('no accessible name');
    if (!f.onScreen) problems.push('focused element is off-screen or hidden');
    if (!f.ringVisible) problems.push('no visible focus ring');
    seen.set(key, {
      index: 0, desc: f.name ? `${f.role} "${f.name}"` : `${f.role}`,
      role: f.role ?? '?', name: f.name ?? '', onScreen: !!f.onScreen, ringVisible: !!f.ringVisible, problems,
      tabindex: f.tabindex ?? 0, order: f.order ?? 0,
    });
    cycle.push(key);
  }

  // 사람이 보는 순서로 돌린다 — 양수 tabindex 가 먼저(오름차순), 그다음 문서 순
  const ordered = cycle.map(k => seen.get(k)!);
  if (trapAt === null) {
    ordered.sort((a, b) => (a.tabindex && b.tabindex ? a.tabindex - b.tabindex : a.tabindex ? -1 : b.tabindex ? 1 : a.order - b.order));
  }
  const stops: TabStop[] = ordered.map((s, i) => ({ index: i + 1, desc: s.desc, role: s.role, name: s.name, onScreen: s.onScreen, ringVisible: s.ringVisible, problems: s.problems }));
  return { stops, trapAt, wrapped: sawBody || (trapAt === null && stops.length > 0), problems: stops.reduce((n, s) => n + s.problems.length, 0) + (trapAt !== null ? 1 : 0) };
}
