import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateLines, truncationNote, resolveMaxOutput, boundariesEnabled, makeBoundary } from '../src/output/page-content.js';

// 잘림 표시가 없는 잘림은 하지 않는다 (#190). 여기서 잠그는 것은 (1) 줄 단위로 자른다,
// (2) 몇 줄 중 몇 줄인지 언제나 말한다, (3) 상한이 없으면 아무것도 안 건드린다.

const lines = ['@1  RootWebArea', '@2    link "Home"', '@3    button "Go"', '@4    heading "x"'];

test('상한이 없으면 그대로', () => {
  assert.deepEqual(truncateLines(lines, undefined), { lines });
});

test('넘으면 줄 경계에서 자르고 몇 줄 중 몇 줄인지 적는다', () => {
  const r = truncateLines(lines, 40);
  assert.deepEqual(r.lines, ['@1  RootWebArea', '@2    link "Home"']);
  assert.deepEqual(r.truncation, { shownLines: 2, totalLines: 4, shownChars: 34, totalChars: 70 });
  const note = truncationNote(r.truncation!, 'Narrow with --selector');
  assert.match(note, /showed 2 of 4 lines/);
  assert.match(note, /34\/70 chars/);
  assert.match(note, /--selector/);
});

test('딱 맞으면 잘리지 않는다', () => {
  assert.equal(truncateLines(lines, 70).truncation, undefined);
});

test('상한은 옵션 → env → 없음, 0 이하는 없음', () => {
  const saved = process.env['TIRNO_MAX_OUTPUT'];
  try {
    delete process.env['TIRNO_MAX_OUTPUT'];
    assert.equal(resolveMaxOutput(undefined), undefined);
    assert.equal(resolveMaxOutput(500), 500);
    assert.equal(resolveMaxOutput(0), undefined);
    process.env['TIRNO_MAX_OUTPUT'] = '1200';
    assert.equal(resolveMaxOutput(undefined), 1200);
    assert.equal(resolveMaxOutput(50), 50, '옵션이 env 를 이긴다');
    process.env['TIRNO_MAX_OUTPUT'] = 'abc';
    assert.equal(resolveMaxOutput(undefined), undefined);
  } finally {
    if (saved === undefined) delete process.env['TIRNO_MAX_OUTPUT']; else process.env['TIRNO_MAX_OUTPUT'] = saved;
  }
});

test('경계는 옵션 또는 TIRNO_CONTENT_BOUNDARIES=1, nonce 는 실행마다 다르다', () => {
  const saved = process.env['TIRNO_CONTENT_BOUNDARIES'];
  try {
    delete process.env['TIRNO_CONTENT_BOUNDARIES'];
    assert.equal(boundariesEnabled(undefined), false);
    assert.equal(boundariesEnabled(true), true);
    process.env['TIRNO_CONTENT_BOUNDARIES'] = '1';
    assert.equal(boundariesEnabled(undefined), true);
  } finally {
    if (saved === undefined) delete process.env['TIRNO_CONTENT_BOUNDARIES']; else process.env['TIRNO_CONTENT_BOUNDARIES'] = saved;
  }
  const a = makeBoundary('a11y tree'), b = makeBoundary('a11y tree');
  assert.notEqual(a.nonce, b.nonce);
  assert.match(a.begin, /^--- a11y tree \(untrusted\) begin [0-9a-f]{6} ---$/);
  assert.match(a.end, new RegExp(`end ${a.nonce} ---$`));
});
