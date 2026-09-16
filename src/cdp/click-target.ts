/**
 * 클릭 지점에 정말 그 요소가 있는가 (#183).
 *
 * `this.click()` 은 합성 클릭이라 **가려진 요소도 눌린다** — 모달 뒤의 버튼에 onclick 이
 * 돌고 `✓ Clicked` 가 찍힌다(실측). 사람은 그 자리를 누르면 모달을 누른다. 그래서 ref
 * 클릭도 좌표로 실제 마우스를 보내고, 보내기 전에 그 좌표에 무엇이 있는지 본다.
 */

/**
 * 페이지 안에서 `this` 로 실행된다. 스크롤해서 보이게 한 뒤 중심 좌표를 재고, 그 자리의
 * 요소(열린 shadow root 안까지 내려가서)와 대상의 관계를 판정한다.
 *
 * - `self` / `inside`: 그 자리가 대상이거나 대상 안쪽이다 — 눌러도 된다
 * - `ancestor`: 대상이 `pointer-events:none` 이라 부모가 받는다 — 버튼 속 아이콘이 흔한
 *   예고, 진짜 클릭도 부모에게 가므로 기대한 효과다. 눌러도 된다
 * - `covered`: 관계없는 요소가 위에 있다 — 거절
 * - `offscreen`: 스크롤해도 중심이 뷰포트 밖이다 (뷰포트보다 큰 요소) — 거절
 * - `no-box`: 크기가 0 이다 (display:none · 빈 인라인) — 거절
 * - `detached`: 문서에서 떨어져 나간 노드다 (리렌더로 교체됨) — 거절. 합성 click() 은
 *   떨어진 노드에도 핸들러를 돌려서, 옛 ref 가 "눌렸다" 고 나왔다
 */
export const HIT_TEST = `function(){
  // a11y 트리의 StaticText 는 텍스트 노드다 — 박스가 없으니 그 부모를 누른다
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return { x: 0, y: 0, relation: 'no-box', hit: null };
  if (!el.isConnected) return { x: 0, y: 0, relation: 'detached', hit: null };
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const desc = (n) => {
    if (!n || n.nodeType !== 1) return String(n && n.nodeName || '?').toLowerCase();
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    const cls = typeof n.className === 'string' ? n.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += '.' + cls.join('.');
    const t = (n.textContent || '').trim().replace(/\\s+/g, ' ');
    if (t) s += ' "' + (t.length > 30 ? t.slice(0, 30) + '…' : t) + '"';
    return s;
  };
  if (r.width === 0 || r.height === 0) return { x, y, relation: 'no-box', hit: null };
  const doc = el.ownerDocument;
  if (x < 0 || y < 0 || x > doc.documentElement.clientWidth || y > doc.documentElement.clientHeight) {
    return { x, y, relation: 'offscreen', hit: null };
  }
  let hit = doc.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    const deeper = hit.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === hit) break;
    hit = deeper;
  }
  if (!hit) return { x, y, relation: 'offscreen', hit: null };
  const up = (n) => n.parentNode || n.host || null;
  let relation = 'covered';
  if (hit === el) relation = 'self';
  else {
    for (let n = hit; n; n = up(n)) if (n === el) { relation = 'inside'; break; }
    if (relation === 'covered') for (let n = el; n; n = up(n)) if (n === hit) { relation = 'ancestor'; break; }
  }
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, relation, hit: relation === 'covered' ? desc(hit) : null };
}`;

export type HitRelation = 'self' | 'inside' | 'ancestor' | 'covered' | 'offscreen' | 'no-box' | 'detached';

export interface HitTest {
  x: number;
  y: number;
  relation: HitRelation;
  /** `covered` 일 때 가린 요소의 짧은 표기 */
  hit: string | null;
}

/** 눌러도 되면 null, 아니면 거절 사유. 사유는 다음에 뭘 하면 되는지까지 말한다. */
export function refuseClick(label: string, h: HitTest): string | null {
  const at = `(${h.x},${h.y})`;
  switch (h.relation) {
    case 'self':
    case 'inside':
    case 'ancestor':
      return null;
    case 'covered':
      return `${label} is covered at ${at} by ${h.hit} — a real click would land there. Dismiss it (or click it) first, then snapshot again. --synthetic forces a click() that ignores what is on top`;
    case 'offscreen':
      return `${label} centre ${at} is outside the viewport even after scrolling — the element is larger than the viewport. Click a point inside it with "x,y", or --synthetic`;
    case 'no-box':
      return `${label} has no box (display:none, or an empty inline element) — nothing to click at. --synthetic sends click() to it anyway`;
    case 'detached':
      return `${label} is no longer in the document — the page re-rendered and replaced it. Run "tirno snapshot" and use the new ref`;
  }
}
