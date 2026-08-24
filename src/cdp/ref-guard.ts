import type { CDPSession } from 'puppeteer-core';
import type { RefStore, StoredRef } from '../core/ref-store.js';

/**
 * `@N` 이 아직 그때 그 요소인가.
 *
 * `snapshot` 이 붙이는 번호에 세대가 없어서, 스냅샷 뒤 페이지가 바뀌면 옛 ref 가 조용히
 * 다른 요소를 가리켰다. **실패가 에러가 아니라 오동작으로 나온다** (#138) — 캐러셀을
 * 13라운드 돌 때 매 라운드 snapshot 을 다시 뜨는 대신 CSS 셀렉터로 내려간 이유가
 * 정확히 이것이다. 대표 셀링 포인트를 못 쓰게 만드는 종류의 결함이다.
 *
 * 두 층으로 본다. 하나로는 안 되기 때문이다(둘 다 실측):
 *
 * 1. **loaderId** — 문서가 다시 로드되면 바뀐다. `nav` 와 `reload` 를 잡는다.
 *    같은 문서 안에서 DOM 만 갈아치우는 SPA 라우팅은 못 잡는다.
 * 2. **요소의 identity** — 그 backendNodeId 의 a11y 역할·이름이 스냅샷 때와 같은가.
 *    DOM 이 교체되면 그 노드는 분리(detached)되는데, `DOM.describeNode` 는 분리된
 *    노드에도 **성공한다**. 즉 클릭은 "성공" 하고 아무 일도 안 일어난다. a11y 쪽은
 *    같은 상황에서 role 이 `none` 으로, name 이 undefined 로 무너진다 — 그것이 신호다.
 *
 * 어긋나면 거부한다. 이 프로젝트는 flag 에도 소유권에도 같은 규율을 쓴다 — 선언과 실제가
 * 다르면 조용히 넘어가지 않고 exit 1 이고, 무엇을 하면 되는지 같이 말한다.
 */

export interface RefVerdict {
  ok: boolean;
  reason?: string;
}

interface AXNodeLike {
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
}

async function currentLoaderId(cdp: CDPSession): Promise<string | null> {
  try {
    const tree = await cdp.send('Page.getFrameTree') as unknown as { frameTree: { frame: { loaderId?: string } } };
    return tree.frameTree.frame.loaderId ?? null;
  } catch {
    return null;
  }
}

async function identityOf(cdp: CDPSession, backendNodeId: number): Promise<{ role: string; name: string } | null> {
  try {
    const res = await cdp.send('Accessibility.getPartialAXTree', {
      backendNodeId,
      fetchRelatives: false,
    }) as unknown as { nodes: AXNodeLike[] };
    const node = res.nodes.find(n => n.backendDOMNodeId === backendNodeId) ?? res.nodes[0];
    if (!node) return null;
    return {
      role: String(node.role?.value ?? ''),
      name: node.name?.value === undefined ? '' : String(node.name.value),
    };
  } catch {
    return null;
  }
}

export async function checkRef(
  cdp: CDPSession,
  expr: string,
  stored: StoredRef,
  store: RefStore,
): Promise<RefVerdict> {
  const retake = `Run "tirno snapshot" and use the refs it prints.`;

  if (store.loaderId) {
    const now = await currentLoaderId(cdp);
    if (now && now !== store.loaderId) {
      return {
        ok: false,
        reason: `the document was navigated or reloaded since snapshot generation ${store.generation}` +
          `${store.url ? ` (${store.url})` : ''}. ${retake}`,
      };
    }
  }

  // 옛 스토어에는 identity 가 없다. 없는 것을 근거로 거부하지는 않는다 — 다음
  // snapshot 이 채우고, 그 전까지는 예전과 똑같이 동작한다.
  if (!stored.role) return { ok: true };

  const now = await identityOf(cdp, stored.backendId);
  if (!now) {
    return { ok: false, reason: `that element is gone from the page. ${retake}` };
  }
  if (now.role !== stored.role || (stored.name !== '' && now.name !== stored.name)) {
    return {
      ok: false,
      reason: `${expr} was ${describe(stored.role, stored.name)}, and that node is now ` +
        `${describe(now.role, now.name)} — the page changed under the snapshot. ${retake}`,
    };
  }
  return { ok: true };
}

function describe(role: string, name: string): string {
  return name ? `${role} "${name}"` : (role || '(nothing)');
}
