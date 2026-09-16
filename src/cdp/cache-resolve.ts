/**
 * 캐시의 waypoint 를 지금 페이지의 노드로 되찾는다 (#187).
 *
 * 캐시 항목의 `backendId` 는 그 페이지 인스턴스에서만 유효하다. 새 세션에서 쓰려면 다른
 * 채널로 **다시 찾아야** 하는데, 그 코드가 `replay` 에는 있고 캐시 경로에는 없었다 — 그래서
 * `cache load` 는 출력만 하고 ref store 를 못 채웠고, 꺼낸 `@7` 로 `click` 하면 `Unknown ref`
 * 였다. 순서는 안정적인 채널부터: `dom.selector` → `a11y(role+name)` → `bbox`.
 *
 * 하나라도 못 찾으면 **못 찾았다고 적는다.** 절반만 채우고 조용히 넘어가면 호출자는 나중에
 * `Unknown ref` 로 안다 — 지금 아는 것이 낫다.
 */
import type { CdpSession } from './client.js';
import type { Waypoint } from '../core/visual-cache.js';
import type { Bbox } from './iou.js';

export type Channel = 'dom' | 'a11y' | 'bbox';

export interface Resolution {
  id: string;
  role: string;
  name: string;
  channel: Channel | null;
  backendId?: number;
  /** 사람이 읽을 한 조각 — `iou 0.91` · `1 of 3 by name` · 실패 사유 */
  note: string;
}

const BBOX_MIN_IOU = 0.5;

interface AXHit { backendDOMNodeId?: number; ignored?: boolean; role?: { value?: string } }

async function byDom(cdp: CdpSession, rootNodeId: number, selector: string): Promise<number | null> {
  try {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector }) as { nodeId: number };
    if (!nodeId) return null;
    const { node } = await cdp.send('DOM.describeNode', { nodeId }) as { node: { backendNodeId: number } };
    return node.backendNodeId;
  } catch {
    return null;
  }
}

/**
 * Chrome 자신의 이름 계산으로 찾는다 — 캐시가 저장한 role·name 이 바로 그 계산의 결과라
 * 손으로 흉내 낸 매칭(replay 의 것)보다 잘 맞는다. 여러 개면 첫 것을 쓰고 몇 개였는지 적는다.
 */
async function byA11y(cdp: CdpSession, rootBackendId: number, role: string, name: string): Promise<{ id: number; note: string } | null> {
  if (!name) return null;                       // 이름 없는 role 은 페이지에 수십 개다
  try {
    const { nodes } = await cdp.send('Accessibility.queryAXTree', {
      backendNodeId: rootBackendId, accessibleName: name, role,
    }) as { nodes: AXHit[] };
    const hits = nodes.filter(n => !n.ignored && n.backendDOMNodeId !== undefined);
    if (hits.length === 0) return null;
    return { id: hits[0].backendDOMNodeId!, note: hits.length === 1 ? 'a11y' : `a11y, 1 of ${hits.length} by role+name` };
  } catch {
    return null;
  }
}

/**
 * 기록된 상자 중심에 지금 무엇이 있고, 그것(또는 그 조상)의 상자가 기록과 얼마나 겹치는가.
 *
 * 중심점이 맞히는 것은 보통 **가장 안쪽** 요소다 — 표의 행을 찾는데 그 안의 링크가 잡힌다.
 * 그래서 조상으로 올라가며 IoU 가 가장 큰 것을 고른다. 페이지 안에서 계산하고 요소 하나만
 * 돌려받아 왕복을 한 번으로 줄인다.
 */
const BEST_ANCESTOR_AT = `function(x, y, sx, sy, sw, sh){
  const iou = (r) => {
    const ix = Math.max(0, Math.min(r.right, sx + sw) - Math.max(r.left, sx));
    const iy = Math.max(0, Math.min(r.bottom, sy + sh) - Math.max(r.top, sy));
    const inter = ix * iy, union = r.width * r.height + sw * sh - inter;
    return union > 0 ? inter / union : 0;
  };
  let el = document.elementFromPoint(x, y);
  let best = null, bestIou = 0;
  for (let depth = 0; el && depth < 12; el = el.parentElement, depth++) {
    const v = iou(el.getBoundingClientRect());
    if (v > bestIou) { best = el; bestIou = v; }
  }
  return best && bestIou > 0 ? { el: best, iou: bestIou } : null;
}`;

async function byBbox(cdp: CdpSession, stored: Bbox): Promise<{ id: number; note: string } | null> {
  try {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(${BEST_ANCESTOR_AT})(${Math.round(stored.x + stored.w / 2)}, ${Math.round(stored.y + stored.h / 2)}, ${stored.x}, ${stored.y}, ${stored.w}, ${stored.h})`,
    }) as { result: { objectId?: string; subtype?: string } };
    if (!result.objectId || result.subtype === 'null') return null;
    const props = await cdp.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true }) as {
      result: Array<{ name: string; value?: { objectId?: string; value?: number } }>;
    };
    const el = props.result.find(p => p.name === 'el')?.value?.objectId;
    const overlap = props.result.find(p => p.name === 'iou')?.value?.value ?? 0;
    if (!el || overlap < BBOX_MIN_IOU) return null;
    const { node } = await cdp.send('DOM.describeNode', { objectId: el }) as { node: { backendNodeId: number } };
    return { id: node.backendNodeId, note: `bbox, iou ${overlap.toFixed(2)}` };
  } catch {
    return null;
  }
}

export async function resolveWaypoints(cdp: CdpSession, waypoints: Waypoint[]): Promise<Resolution[]> {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 }) as { root: { nodeId: number; backendNodeId: number } };
  const out: Resolution[] = [];
  for (const w of waypoints) {
    const role = w.channels.a11y?.role ?? '?';
    const name = w.channels.a11y?.name ?? '';
    const id = w.refId ?? w.id;
    const tried: string[] = [];

    const sel = w.channels.dom?.selector;
    if (sel) {
      const hit = await byDom(cdp, root.nodeId, sel);
      if (hit !== null) { out.push({ id, role, name, channel: 'dom', backendId: hit, note: `dom ${sel}` }); continue; }
      tried.push(`selector ${sel} matched nothing`);
    }
    const a = await byA11y(cdp, root.backendNodeId, role, name);
    if (a) { out.push({ id, role, name, channel: 'a11y', backendId: a.id, note: a.note }); continue; }
    tried.push(name ? `no ${role} named ${JSON.stringify(name)}` : `${role} has no name to match`);

    const box = w.channels.visual?.bbox;
    if (box) {
      const b = await byBbox(cdp, box);
      if (b) { out.push({ id, role, name, channel: 'bbox', backendId: b.id, note: b.note }); continue; }
      tried.push(`nothing overlapping (${box.x},${box.y} ${box.w}x${box.h}) by ≥${BBOX_MIN_IOU}`);
    } else {
      tried.push('no bbox recorded');
    }
    out.push({ id, role, name, channel: null, note: tried.join('; ') });
  }
  return out;
}

export function summarize(rs: Resolution[]): { line: string; resolved: number; unresolved: number } {
  const by = { dom: 0, a11y: 0, bbox: 0 };
  let unresolved = 0;
  for (const r of rs) r.channel ? by[r.channel]++ : unresolved++;
  const resolved = rs.length - unresolved;
  const parts = (['dom', 'a11y', 'bbox'] as const).filter(c => by[c] > 0).map(c => `${c} ${by[c]}`).join(' · ');
  return { line: `loaded ${rs.length} refs, ${resolved} resolved${parts ? ` (${parts})` : ''}, ${unresolved} unresolved`, resolved, unresolved };
}
