/**
 * 행동 뒤 무엇이 변했는가 (#209).
 *
 * `✓ Clicked` 로 끝나면 호출자는 스냅샷을 다시 찍어야 하고, "눌렀는데 아무 일도 안 났다" 는
 * 그 스냅샷을 이전 것과 비교해야만 안다 — 조용한 성공의 마지막 은신처가 거기다. 그래서
 * 행동 명령이 전후의 a11y 트리·URL·console 을 대보고 **변한 것만** 낸다. 변한 것이 없으면
 * 그렇다고 말한다.
 */
import type { Page, ConsoleMessage } from './page.js';
import { renderAXTree, type AXNode } from './ax-render.js';

export interface Delta {
  url: { from: string; to: string } | null;
  /** 포커스가 옮겨갔나 — press/type 의 효과는 대개 트리가 아니라 여기 나타난다 */
  focus: { from: string; to: string } | null;
  added: string[];
  removed: string[];
  /** 잘린 개수 — 출력 상한을 넘은 만큼 */
  moreAdded: number;
  moreRemoved: number;
  console: { errors: number; samples: string[] };
  dialogs: string[];
  /** 정착을 얼마나 기다렸나 */
  settledMs: number;
  /** 트리를 못 읽었으면(문서 교체 중 등) 왜 */
  unavailable?: string;
}

export const MAX_LINES = 8;

interface Capture { url: string; lines: string[]; focus: string }

/** activeElement 를 한 조각으로 — `textbox#email` · `button "Save"` · `body` */
const FOCUS_DESC = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return 'body';
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') || ({a:'link',button:'button',input:(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'),textarea:'textbox',select:'combobox'})[tag] || tag;
  const name = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || (el.textContent || '').trim().slice(0, 30);
  return name ? role + ' "' + name + '"' : role;
})()`;

/** 번호·들여쓰기를 뺀 내용 줄 — 위치가 바뀐 것은 변화가 아니다 */
function contentLines(nodes: AXNode[]): string[] {
  return renderAXTree(nodes, true, true).lines.map(l => l.replace(/^(@\d+\s*|\s{3})\s*/, ''));
}

async function capture(page: Page): Promise<Capture> {
  const [tree, focus] = await Promise.all([
    page.session.send('Accessibility.getFullAXTree'),
    page.evaluate<string>(FOCUS_DESC).catch(() => '?'),
  ]);
  return { url: page.url(), lines: contentLines(tree.nodes as unknown as AXNode[]), focus };
}

/** 다중집합 차 — 같은 줄이 둘 있다가 하나가 되면 하나가 빠진 것이다 */
export function diffLines(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const count = new Map<string, number>();
  for (const l of before) count.set(l, (count.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const [l, n] of count) for (let i = 0; i < n; i++) removed.push(l);
  return { added, removed };
}

/**
 * 행동 하나를 감싼다: 전 캡처 → 행동 → 정착 대기 → 후 캡처 → 차이.
 *
 * 정착: 행동이 네비게이션을 일으켰으면 새 문서의 domcontentloaded 까지(최대 `navTimeout`),
 * 아니면 네트워크가 `idle` 동안 조용할 때까지(상한 `settleMax`). 상한은 짧다 — 이것은
 * 관측이지 대기 명령이 아니고, 더 기다려야 하면 `wait-for` 가 있다.
 */
export async function withDelta<T>(
  page: Page,
  action: () => Promise<T>,
  opts: { idle?: number; settleMax?: number; navTimeout?: number } = {},
): Promise<{ result: T; delta: Delta }> {
  const idle = opts.idle ?? 300;
  const settleMax = opts.settleMax ?? 1500;
  const navTimeout = opts.navTimeout ?? 3000;

  const errors: string[] = [];
  const dialogs: string[] = [];
  let navigated = false;
  const onConsole = (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); };
  const onError = (e: Error) => { errors.push(e.message.split('\n')[0]); };
  const onDialog = (d: { type: string; message: string }) => { dialogs.push(`${d.type}: ${d.message}`); };
  const onNav = () => { navigated = true; };

  const before = await capture(page);
  page.on('console', onConsole);
  page.on('pageerror', onError);
  page.on('dialog', onDialog);
  page.on('navigated', onNav);
  const t0 = Date.now();
  try {
    const result = await action();
    // 정착 1 — 네트워크가 idle 동안 조용해질 때까지, 상한 settleMax. 그 사이 네비게이션이
    // 시작되면 바로 2 로 간다 (click 은 커밋 전에 돌아오므로 여기서 잡힌다).
    const settleDeadline = Date.now() + settleMax;
    while (!navigated && Date.now() < settleDeadline) {
      const quiet = page.networkQuietFor();
      if (quiet >= idle) break;
      await sleep(50);
    }
    // 정착 2 — 새 문서가 파싱을 끝낼 때까지(readyState !== loading), 상한 navTimeout
    if (navigated) {
      const navDeadline = Date.now() + navTimeout;
      while (Date.now() < navDeadline) {
        const state = await page.evaluate<string>('document.readyState').catch(() => 'loading');
        if (state !== 'loading') break;
        await sleep(50);
      }
    }
    const settledMs = Date.now() - t0;
    let after: Capture | null = null;
    let unavailable: string | undefined;
    try {
      after = await capture(page);
    } catch (e) {
      unavailable = (e as Error).message.split('\n')[0];
    }
    const diff = after ? diffLines(before.lines, after.lines) : { added: [], removed: [] };
    const delta: Delta = {
      url: after && after.url !== before.url ? { from: before.url, to: after.url } : null,
      focus: after && after.focus !== before.focus && !(before.url !== after.url) ? { from: before.focus, to: after.focus } : null,
      added: diff.added.slice(0, MAX_LINES),
      removed: diff.removed.slice(0, MAX_LINES),
      moreAdded: Math.max(0, diff.added.length - MAX_LINES),
      moreRemoved: Math.max(0, diff.removed.length - MAX_LINES),
      console: { errors: errors.length, samples: errors.slice(0, 2) },
      dialogs,
      settledMs,
      ...(unavailable ? { unavailable } : {}),
    };
    return { result, delta };
  } finally {
    page.off('console', onConsole as never);
    page.off('pageerror', onError as never);
    page.off('dialog', onDialog as never);
    page.off('navigated', onNav as never);
  }
}

export function isNoChange(d: Delta): boolean {
  return !d.url && !d.focus && d.added.length === 0 && d.removed.length === 0 && d.console.errors === 0 && d.dialogs.length === 0 && !d.unavailable;
}

/** 사람용 줄들 — 성공 줄 아래 두 칸 들여 쓴다 */
export function formatDelta(d: Delta): string[] {
  if (isNoChange(d)) return [`no change (url · tree · console all as before, watched ${(d.settledMs / 1000).toFixed(1)}s)`];
  const out: string[] = [];
  if (d.url) out.push(`url: ${short(d.url.from)} → ${short(d.url.to)}`);
  if (d.focus) out.push(`focus: ${d.focus.from} → ${d.focus.to}`);
  if (d.unavailable) out.push(`tree: could not read after the action — ${d.unavailable}`);
  if (d.added.length) out.push(`+${d.added.length + d.moreAdded}  ${d.added.join(' · ')}${d.moreAdded ? ` … +${d.moreAdded} more` : ''}`);
  if (d.removed.length) out.push(`-${d.removed.length + d.moreRemoved}  ${d.removed.join(' · ')}${d.moreRemoved ? ` … +${d.moreRemoved} more` : ''}`);
  if (d.dialogs.length) out.push(`dialog: ${d.dialogs.join(' · ')} (auto-accepted)`);
  if (d.console.errors) out.push(`console: ${d.console.errors} error${d.console.errors === 1 ? '' : 's'} — ${d.console.samples.join(' · ')}`);
  return out;
}

/** 같은 origin 이면 경로만 — 한 줄에 두 URL 이 들어간다 */
function short(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? u.pathname.split('/').slice(-1)[0] : u.host + u.pathname + u.search;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
