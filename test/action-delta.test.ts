import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, formatDelta, isNoChange, MAX_LINES, type Delta } from '../src/cdp/action-delta.js';

// 행동 뒤 delta (#209). 여기서 잠그는 것은 (1) 다중집합 차 — 위치 변화는 변화가 아니고
// 같은 줄이 둘에서 하나가 되면 하나가 빠진 것이다, (2) 변한 게 없으면 그렇다고 말한다,
// (3) 상한을 넘으면 몇 개가 더 있는지 적는다.

const base: Delta = { url: null, focus: null, added: [], removed: [], moreAdded: 0, moreRemoved: 0, console: { errors: 0, samples: [] }, dialogs: [], settledMs: 300 };

test('다중집합 차 — 순서가 바뀐 것은 변화가 아니다', () => {
  const d = diffLines(['a', 'b', 'c'], ['c', 'b', 'a']);
  assert.deepEqual(d, { added: [], removed: [] });
});

test('같은 줄이 둘에서 하나가 되면 하나가 빠진 것이다', () => {
  const d = diffLines(['row', 'row', 'row'], ['row']);
  assert.deepEqual(d.removed, ['row', 'row']);
  assert.deepEqual(d.added, []);
});

test('추가와 삭제를 함께 낸다', () => {
  const d = diffLines(['StaticText "idle"', 'button "go"'], ['button "go"', 'StaticText "clicked"']);
  assert.deepEqual(d.added, ['StaticText "clicked"']);
  assert.deepEqual(d.removed, ['StaticText "idle"']);
});

test('변한 것이 없으면 그렇다고 한 줄로 말한다', () => {
  assert.ok(isNoChange(base));
  assert.match(formatDelta(base)[0], /no change .* watched 0\.3s/);
});

test('url · focus · ± · dialog · console 순으로 낸다', () => {
  const lines = formatDelta({
    ...base,
    url: { from: 'https://a.com/form', to: 'https://a.com/done' },
    focus: { from: 'body', to: 'textbox "q"' },
    added: ['alert "Saved"'], removed: ['button "Submit"'],
    dialogs: ['alert: bye'],
    console: { errors: 2, samples: ['boom', 'TypeError: x'] },
  });
  assert.match(lines[0], /^url: a\.com\/form → a\.com\/done$/);
  assert.match(lines[1], /^focus: body → textbox "q"$/);
  assert.match(lines[2], /^\+1 {2}alert "Saved"$/);
  assert.match(lines[3], /^-1 {2}button "Submit"$/);
  assert.match(lines[4], /dialog: alert: bye \(auto-accepted\)/);
  assert.match(lines[5], /console: 2 errors — boom · TypeError: x/);
});

test('상한을 넘으면 총 개수와 더 있는 개수를 적는다', () => {
  const added = Array.from({ length: MAX_LINES }, (_, i) => `link "${i}"`);
  const lines = formatDelta({ ...base, added, moreAdded: 17 });
  assert.match(lines[0], new RegExp(`^\\+${MAX_LINES + 17}  link "0"`));
  assert.match(lines[0], /… \+17 more$/);
});

test('트리를 못 읽었으면 그것도 변화다 — 침묵하지 않는다', () => {
  const d = { ...base, unavailable: 'target closed' };
  assert.ok(!isNoChange(d));
  assert.match(formatDelta(d)[0], /could not read after the action — target closed/);
});
