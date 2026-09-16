import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { refuseClick, type HitTest } from '../src/cdp/click-target.js';
import { clickByRef } from '../src/cdp/dom-actions.js';

// `this.click()` 은 가려진 요소도 누른다 — 모달 뒤 버튼의 onclick 이 돌고 "Clicked" 가
// 찍혔다(실측, #183). 기본 경로는 이제 좌표에 무엇이 있는지 보고 실제 마우스를 보낸다.
// 여기서 잠그는 것은 (1) 판정별로 눌러도 되는지, (2) 거절이면 마우스를 안 보내는지다.

const at = (relation: HitTest['relation'], hit: string | null = null): HitTest => ({ x: 10, y: 20, relation, hit });

test('자기 자신·안쪽·조상은 눌러도 된다', () => {
  assert.equal(refuseClick('@1', at('self')), null);
  assert.equal(refuseClick('@1', at('inside')), null);
  // pointer-events:none 인 아이콘 — 진짜 클릭도 부모에게 가므로 기대한 효과다
  assert.equal(refuseClick('@1', at('ancestor')), null);
});

test('가려졌으면 가린 것을 이름으로 말하고 다음 할 일을 준다', () => {
  const m = refuseClick('@7', at('covered', 'div#cover.modal-backdrop'))!;
  assert.match(m, /@7 is covered at \(10,20\) by div#cover\.modal-backdrop/);
  assert.match(m, /Dismiss it/);
  assert.match(m, /--synthetic/);
});

test('박스가 없거나 뷰포트 밖이거나 문서에서 떨어졌으면 거절한다', () => {
  assert.match(refuseClick('#x', at('no-box'))!, /no box/);
  assert.match(refuseClick('#x', at('offscreen'))!, /outside the viewport/);
  // 합성 click() 은 떨어진 노드의 핸들러도 돌려서 옛 ref 가 "눌렸다" 고 나왔다
  assert.match(refuseClick('@9', at('detached'))!, /no longer in the document/);
});

function fakePage(hit: HitTest): { page: Page; calls: string[]; clicks: Array<[number, number]> } {
  const calls: string[] = [];
  const clicks: Array<[number, number]> = [];
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      calls.push(String((params as { functionDeclaration?: string })?.functionDeclaration ?? method));
      return { result: { value: hit } };
    },
    detach: async () => {},
  };
  const page = {
    createCDPSession: async () => cdp,
    mouse: { click: async (x: number, y: number) => { clicks.push([x, y]); } },
  } as unknown as Page;
  return { page, calls, clicks };
}

test('기본 경로는 판정 뒤 그 좌표로 실제 마우스를 보낸다', async () => {
  const { page, calls, clicks } = fakePage(at('self'));
  await clickByRef(page, 42, { label: '@42' });
  assert.equal(calls.length, 1, '판정 한 번뿐이다 — this.click() 은 없다');
  assert.match(calls[0], /elementFromPoint/);
  assert.deepEqual(clicks, [[10, 20]]);
});

test('가려졌으면 마우스를 보내지 않고 던진다', async () => {
  const { page, clicks } = fakePage(at('covered', 'div#modal'));
  await assert.rejects(clickByRef(page, 42, { label: '@42' }), /covered .* by div#modal/);
  assert.deepEqual(clicks, [], '거절했으면 아무것도 누르지 않아야 한다');
});

test('페이지가 판정 중에 던지면 그 예외가 올라온다 — 성공으로 접히지 않는다', async () => {
  const cdp = {
    send: async (method: string) => method === 'DOM.resolveNode'
      ? { object: { objectId: 'o' } }
      : { result: {}, exceptionDetails: { exception: { description: 'TypeError: boom\n  at x' } } },
    detach: async () => {},
  };
  const page = { createCDPSession: async () => cdp, mouse: { click: async () => {} } } as unknown as Page;
  await assert.rejects(clickByRef(page, 1, { label: '@1' }), /page threw during click: TypeError: boom/);
});
