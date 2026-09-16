/**
 * 대상 문법 — role + 보이는 이름이 1급 (#210).
 *
 * `click button "Submit"` · `fill textbox "Email" me@x` · `hover link "Docs"`. `@N` 과 CSS
 * 셀렉터와 `"x,y"` 는 그대로 받되 보조다. 이름은 부분 일치(대소문자 무시)가 기본이고
 * `--exact` 로 정확히. **모호하면 후보를 나열하고 거절한다** — 첫 것을 조용히 고르지 않는다.
 *
 * 매칭은 `Accessibility.queryAXTree` — Chrome 자신의 이름 계산이라 `snapshot` 이 보여 준 것과
 * 같은 이름이다(cache-resolve 가 쓰는 것과 같은 길).
 */
import type { CdpSession } from './client.js';
import type { Page } from './page.js';
import { TirnoError } from '../util/errors.js';
import * as refStore from '../core/ref-store.js';
import { checkRef } from './ref-guard.js';
import { asCoords } from './dom-actions.js';

/** 사용자가 치는 role 단어 → Chrome AX role. 같으면 생략. */
const ROLE_ALIASES: Record<string, string> = {
  text: 'StaticText', img: 'image', input: 'textbox', select: 'combobox', a: 'link',
};

export const ROLE_WORDS = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'tabpanel', 'switch', 'slider', 'spinbutton',
  'heading', 'image', 'img', 'text', 'cell', 'gridcell', 'row', 'columnheader', 'rowheader',
  'dialog', 'alertdialog', 'alert', 'status', 'navigation', 'main', 'banner', 'contentinfo', 'region',
  'form', 'list', 'listitem', 'table', 'article', 'group', 'tooltip', 'progressbar', 'separator',
  'input', 'select', 'a', 'treeitem', 'menu', 'menubar', 'toolbar',
]);

export function isRoleWord(s: string): boolean {
  return ROLE_WORDS.has(s.toLowerCase());
}

export function axRole(word: string): string {
  const w = word.toLowerCase();
  return ROLE_ALIASES[w] ?? w;
}

export interface Candidate { backendNodeId: number; role: string; name: string; ref?: string }

export type Target =
  | { kind: 'coords'; x: number; y: number; label: string }
  | { kind: 'node'; backendNodeId: number; label: string; role?: string; name?: string };

export interface ResolveOptions {
  session: string;
  staleOk?: boolean;
  exact?: boolean;
}

/**
 * 첫 positional 과 (있으면) 둘째로 대상을 정한다.
 *
 * - `"x,y"` → 좌표
 * - `@N` / `@vG:N` → ref (세대·identity 검사, `staleOk` 로 강행)
 * - role 단어 [+ 이름] → a11y 매칭
 * - 그 외 → CSS 셀렉터 (light DOM 먼저, 없으면 열린 shadow root 관통)
 *
 * role 단어 하나만 오고 이름이 없으면 그 role 이 페이지에 하나일 때만 맞는다 — CSS 태그
 * 셀렉터 `button` 이 첫 것을 조용히 고르던 것과 다르다. 그것이 원하는 거면 `css:button`.
 */
export async function resolveTarget(page: Page, first: string, second: string | undefined, opts: ResolveOptions): Promise<Target> {
  const coords = asCoords(first);
  if (coords) return { kind: 'coords', x: coords[0], y: coords[1], label: `(${coords[0]},${coords[1]})` };

  if (refStore.isRef(first)) {
    const backendNodeId = await refToBackendId(page, opts.session, first, !!opts.staleOk);
    const stored = refStore.resolveStored(opts.session, first).stored;
    return { kind: 'node', backendNodeId, label: first, role: stored.role, name: stored.name };
  }

  if (first.startsWith('css:')) {
    return bySelector(page, first.slice(4));
  }

  if (isRoleWord(first)) {
    return byRoleName(page, first, second, opts);
  }

  return bySelector(page, first);
}

/** role 단어 뒤에 이름이 올 자리인가 — 명령이 `[name]` positional 을 어떻게 나눌지 정할 때 쓴다 */
export function takesName(first: string): boolean {
  return isRoleWord(first) && !refStore.isRef(first) && !asCoords(first);
}

async function bySelector(page: Page, selector: string): Promise<Target> {
  const direct = await page.$(selector);
  const el = direct ?? (/^(?:pierce|xpath|text|aria)\//.test(selector) ? null : await page.$(`pierce/${selector}`));
  if (!el) throw new TirnoError(`No element found for selector: ${selector}`, 'target_not_found', { selector });
  return { kind: 'node', backendNodeId: el.backendNodeId(), label: selector };
}

async function byRoleName(page: Page, roleWord: string, name: string | undefined, opts: ResolveOptions): Promise<Target> {
  const role = axRole(roleWord);
  const label = name === undefined ? roleWord : `${roleWord} "${name}"`;
  const cdp = await page.createCDPSession();
  try {
    const candidates = await findByRoleName(cdp, role, name, !!opts.exact);
    if (candidates.length === 1) {
      const c = candidates[0];
      return { kind: 'node', backendNodeId: c.backendNodeId, label, role: c.role, name: c.name };
    }
    if (candidates.length === 0) {
      throw new TirnoError(
        name === undefined
          ? `No ${roleWord} on this page`
          : `No ${roleWord} named ${JSON.stringify(name)}${opts.exact ? ' (exact)' : ''} — \`tirno snapshot\` lists what is here`,
        'target_not_found', { role, name },
      );
    }
    // 모호 — 후보를 이름으로 대고 거절한다. ref store 에 있는 것은 @N 도 붙인다.
    const store = refStore.load(opts.session);
    const refOf = new Map(Object.entries(store.refs).map(([k, v]) => [v.backendId, `@${k}`]));
    const shown = candidates.slice(0, 6).map(c => {
      const ref = refOf.get(c.backendNodeId);
      return ref ? `${ref} ${JSON.stringify(c.name)}` : JSON.stringify(c.name);
    }).join(' · ');
    throw new TirnoError(
      `${label} matches ${candidates.length}: ${shown}${candidates.length > 6 ? ' …' : ''} — be exact (--exact), or use @N`,
      'ambiguous_target', { role, name, candidates: candidates.map(c => ({ ...c, ref: refOf.get(c.backendNodeId) })) },
    );
  } finally {
    await cdp.detach();
  }
}

/**
 * role 로 모으고 이름은 여기서 거른다 — `queryAXTree` 의 `accessibleName` 은 정확 일치라
 * 부분 일치 기본값을 못 준다. ignored 노드와 이름 없는 노드(이름을 준 경우)는 뺀다.
 */
export async function findByRoleName(cdp: CdpSession, role: string, name: string | undefined, exact: boolean): Promise<Candidate[]> {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodes } = await cdp.send('Accessibility.queryAXTree', { backendNodeId: root.backendNodeId, role });
  const needle = name?.toLowerCase();
  const out: Candidate[] = [];
  for (const n of nodes) {
    if (n.ignored || n.backendDOMNodeId === undefined) continue;
    const nm = String(n.name?.value ?? '');
    if (needle !== undefined) {
      if (exact ? nm !== name : !nm.toLowerCase().includes(needle)) continue;
    }
    out.push({ backendNodeId: n.backendDOMNodeId, role: String(n.role?.value ?? role), name: nm });
  }
  // 부분 일치에서 정확히 같은 이름이 하나뿐이면 그것이다 — "Save" 가 "Save draft" 와 겹치는 흔한 자리
  if (needle !== undefined && !exact && out.length > 1) {
    const exactOnes = out.filter(c => c.name.toLowerCase() === needle);
    if (exactOnes.length === 1) return exactOnes;
  }
  return out;
}

/**
 * `@N` 을 backendNodeId 로 바꾸되, **그것이 아직 그때 그 요소인지 확인하고** 바꾼다 (#138).
 * `staleOk` 는 그 판정을 알고도 진행하겠다는 선언이다.
 */
export async function refToBackendId(page: Page, session: string, target: string, staleOk: boolean): Promise<number> {
  const { stored, store } = refStore.resolveStored(session, target);
  if (staleOk) return stored.backendId;
  const cdp = await page.createCDPSession();
  try {
    const verdict = await checkRef(cdp, target, stored, store);
    if (!verdict.ok) {
      throw new TirnoError(`Refusing ${target}: ${verdict.reason} (--stale-ok proceeds anyway)`, 'stale_ref', { ref: target });
    }
  } finally {
    await cdp.detach();
  }
  return stored.backendId;
}
