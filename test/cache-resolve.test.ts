import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CDPSession } from 'puppeteer-core';
import { resolveWaypoints, summarize } from '../src/cdp/cache-resolve.js';
import type { Waypoint } from '../src/core/visual-cache.js';

// cache load 는 출력만 하고 ref store 를 못 채웠다 — backendId 가 그 페이지 인스턴스에서만
// 유효한데 되찾는 코드가 캐시 경로에 없었다 (#187). 여기서 잠그는 것은 채널 순서
// (dom → a11y → bbox), 그리고 못 찾은 것을 **못 찾았다고 적는가** 다. Chrome 은 안 띄운다.

interface Script {
  querySelector?: Record<string, number>;          // selector → nodeId (0 = miss)
  axHits?: Record<string, number[]>;               // `${role}|${name}` → backendIds
  bboxHit?: { backendId: number; iou: number } | null;
}

function fakeCdp(script: Script): { cdp: CDPSession; calls: string[] } {
  const calls: string[] = [];
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push(method);
      switch (method) {
        case 'DOM.getDocument': return { root: { nodeId: 1, backendNodeId: 100 } };
        case 'DOM.querySelector': return { nodeId: script.querySelector?.[params['selector'] as string] ?? 0 };
        case 'DOM.describeNode':
          if (params['nodeId']) return { node: { backendNodeId: 1000 + (params['nodeId'] as number) } };
          return { node: { backendNodeId: script.bboxHit!.backendId } };
        case 'Accessibility.queryAXTree': {
          const ids = script.axHits?.[`${params['role']}|${params['accessibleName']}`] ?? [];
          return { nodes: ids.map(id => ({ backendDOMNodeId: id, ignored: false })) };
        }
        case 'Runtime.evaluate':
          return script.bboxHit ? { result: { objectId: 'obj' } } : { result: { subtype: 'null' } };
        case 'Runtime.getProperties':
          return { result: [{ name: 'el', value: { objectId: 'el' } }, { name: 'iou', value: { value: script.bboxHit!.iou } }] };
        default: throw new Error(`unexpected ${method}`);
      }
    },
  } as unknown as CDPSession;
  return { cdp, calls };
}

const wp = (id: string, ch: Waypoint['channels']): Waypoint => ({ id, refId: id, channels: ch });

test('selector 가 맞으면 dom 으로 끝난다 — a11y 는 묻지 않는다', async () => {
  const { cdp, calls } = fakeCdp({ querySelector: { '#go': 7 } });
  const [r] = await resolveWaypoints(cdp, [wp('@1', { dom: { selector: '#go' }, a11y: { role: 'button', name: 'Go' } })]);
  assert.equal(r.channel, 'dom');
  assert.equal(r.backendId, 1007);
  assert.ok(!calls.includes('Accessibility.queryAXTree'));
});

test('selector 가 빗나가면 a11y role+name 으로 — 여러 개면 첫 것과 개수', async () => {
  const { cdp } = fakeCdp({ querySelector: { '#gone': 0 }, axHits: { 'button|Go': [55, 56, 57] } });
  const [r] = await resolveWaypoints(cdp, [wp('@2', { dom: { selector: '#gone' }, a11y: { role: 'button', name: 'Go' } })]);
  assert.equal(r.channel, 'a11y');
  assert.equal(r.backendId, 55);
  assert.match(r.note, /1 of 3/);
});

test('이름 없는 role 은 a11y 로 찾지 않고 bbox 로 간다', async () => {
  const { cdp, calls } = fakeCdp({ bboxHit: { backendId: 900, iou: 0.91 } });
  const [r] = await resolveWaypoints(cdp, [wp('@3', { a11y: { role: 'paragraph', name: '' }, visual: { bbox: { x: 10, y: 10, w: 100, h: 20 } } })]);
  assert.equal(r.channel, 'bbox');
  assert.equal(r.backendId, 900);
  assert.match(r.note, /iou 0\.91/);
  assert.ok(!calls.includes('Accessibility.queryAXTree'), '이름 없는 role 로 queryAXTree 를 부르면 수십 개가 맞는다');
});

test('bbox 겹침이 0.5 미만이면 못 찾은 것이다', async () => {
  const { cdp } = fakeCdp({ bboxHit: { backendId: 900, iou: 0.2 } });
  const [r] = await resolveWaypoints(cdp, [wp('@4', { a11y: { role: 'row', name: '' }, visual: { bbox: { x: 0, y: 0, w: 10, h: 10 } } })]);
  assert.equal(r.channel, null);
  assert.equal(r.backendId, undefined);
});

test('못 찾으면 시도한 채널마다 이유를 적는다 — 조용히 비우지 않는다', async () => {
  const { cdp } = fakeCdp({ querySelector: { '#x': 0 }, axHits: {}, bboxHit: null });
  const [r] = await resolveWaypoints(cdp, [wp('@5', { dom: { selector: '#x' }, a11y: { role: 'link', name: 'Old' }, visual: { bbox: { x: 1, y: 2, w: 3, h: 4 } } })]);
  assert.equal(r.channel, null);
  assert.match(r.note, /selector #x matched nothing/);
  assert.match(r.note, /no link named "Old"/);
  assert.match(r.note, /nothing overlapping \(1,2 3x4\)/);
});

test('요약은 채널별 개수와 unresolved 를 센다', () => {
  const s = summarize([
    { id: '@1', role: 'a', name: '', channel: 'dom', backendId: 1, note: '' },
    { id: '@2', role: 'a', name: '', channel: 'a11y', backendId: 2, note: '' },
    { id: '@3', role: 'a', name: '', channel: 'a11y', backendId: 3, note: '' },
    { id: '@4', role: 'a', name: '', channel: null, note: 'x' },
  ]);
  assert.equal(s.line, 'loaded 4 refs, 3 resolved (dom 1 · a11y 2), 1 unresolved');
  assert.equal(s.resolved, 3);
  assert.equal(s.unresolved, 1);
});
