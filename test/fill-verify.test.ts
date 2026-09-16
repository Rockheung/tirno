import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuseBeforeTyping, describeMismatch, type FieldState } from '../src/cdp/fill-verify.js';

// `keyboard.type` 은 readonly · preventDefault · maxlength · 포커스 이동 전부를 예외 없이
// 끝낸다. 그래서 fill 은 되읽어야 하고, 되읽은 결과를 **왜** 다른지까지 말해야 한다 —
// "expected X but got Y" 만으로는 호출자가 다음에 뭘 할지 모른다 (#184).

const base: FieldState = {
  value: '', readOnly: false, disabled: false, maxLength: -1, type: 'text', focused: true, tag: 'input',
};

test('disabled 는 타이핑 전에 거절한다 — 키가 다른 요소로 간다', () => {
  assert.match(refuseBeforeTyping('#d', { ...base, disabled: true })!, /disabled/);
});

test('readonly 는 타이핑 전에 거절한다', () => {
  assert.match(refuseBeforeTyping('@3', { ...base, readOnly: true })!, /readonly/);
});

test('value 도 contenteditable 도 아닌 요소는 거절한다', () => {
  assert.match(refuseBeforeTyping('#x', { ...base, value: null, tag: 'div' })!, /<div>/);
});

test('정상 입력은 거절도 불일치도 없다', () => {
  assert.equal(refuseBeforeTyping('#ok', base), null);
  assert.equal(describeMismatch('#ok', 'hello', { ...base, value: 'hello' }), null);
});

test('maxlength 로 잘린 것을 짚는다', () => {
  const m = describeMismatch('#m', 'hello', { ...base, value: 'hel', maxLength: 3 })!;
  assert.match(m, /maxlength=3/);
  assert.match(m, /expected "hello" but element reads "hel"/);
});

test('포커스가 옮겨간 것을 짚는다', () => {
  assert.match(describeMismatch('#f', 'hello', { ...base, value: 'he', focused: false })!, /focus left/);
});

test('아무것도 안 들어갔으면 preventDefault 를 의심한다', () => {
  assert.match(describeMismatch('#p', 'hello', { ...base, value: '' })!, /preventDefault/);
});

test('값이 바뀌어 들어갔으면 포맷터를 의심하고 --no-verify 를 안내한다', () => {
  const m = describeMismatch('#fmt', '1234', { ...base, value: '12-34' })!;
  assert.match(m, /formatter|mask/);
  assert.match(m, /--no-verify/);
});

test('stdin 값은 메시지에 싣지 않는다 — 길이만', () => {
  const m = describeMismatch('#pw', 'hunter2', { ...base, value: '' }, true)!;
  assert.doesNotMatch(m, /hunter2/);
  assert.match(m, /7 chars/);
});
