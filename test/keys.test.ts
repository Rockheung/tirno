import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editingCommandFor, keyCodeName, modifierBits, parseKeyCombo, virtualKeyCode } from '../src/cdp/keys.js';

test('parseKeyCombo splits on the last "+"', () => {
  assert.deepEqual(parseKeyCombo('Meta+v'), { modifiers: ['Meta'], key: 'v' });
  assert.deepEqual(parseKeyCombo('Ctrl+Shift+a'), { modifiers: ['Control', 'Shift'], key: 'a' });
  assert.deepEqual(parseKeyCombo('Shift+Tab'), { modifiers: ['Shift'], key: 'Tab' });
});

// 키 자체가 `+` 일 수 있다. 앞에서 쪼개면 빈 키가 나온다.
test('parseKeyCombo handles "+" as the key', () => {
  assert.deepEqual(parseKeyCombo('Shift++'), { modifiers: ['Shift'], key: '+' });
});

test('parseKeyCombo leaves a bare key alone', () => {
  assert.deepEqual(parseKeyCombo('Enter'), { modifiers: [], key: 'Enter' });
  assert.deepEqual(parseKeyCombo('a'), { modifiers: [], key: 'a' });
  // 선행 `+` 는 수식키가 없다는 뜻이므로 키로 본다.
  assert.deepEqual(parseKeyCombo('+'), { modifiers: [], key: '+' });
});

test('parseKeyCombo normalises aliases and de-duplicates', () => {
  assert.deepEqual(parseKeyCombo('cmd+v').modifiers, ['Meta']);
  assert.deepEqual(parseKeyCombo('CTRL+v').modifiers, ['Control']);
  assert.deepEqual(parseKeyCombo('option+v').modifiers, ['Alt']);
  assert.deepEqual(parseKeyCombo('Meta+meta+v').modifiers, ['Meta']);
});

test('parseKeyCombo rejects an unknown modifier', () => {
  assert.throws(() => parseKeyCombo('Hyper+v'), /Unknown modifier/);
});

test('modifierBits matches the CDP bit values', () => {
  assert.equal(modifierBits([]), 0);
  assert.equal(modifierBits(['Alt']), 1);
  assert.equal(modifierBits(['Control']), 2);
  assert.equal(modifierBits(['Meta']), 4);
  assert.equal(modifierBits(['Shift']), 8);
  assert.equal(modifierBits(['Meta', 'Shift']), 12);
});

// 키 이벤트만으로는 편집이 일어나지 않는다 — 이 표가 `commands` 를 고른다.
test('editingCommandFor maps the editing combos', () => {
  const c = (s: string) => editingCommandFor(parseKeyCombo(s));
  assert.equal(c('Meta+v'), 'paste');
  assert.equal(c('Ctrl+v'), 'paste');
  assert.equal(c('Meta+c'), 'copy');
  assert.equal(c('Meta+x'), 'cut');
  assert.equal(c('Meta+a'), 'selectAll');
  assert.equal(c('Meta+z'), 'undo');
  assert.equal(c('Meta+Shift+z'), 'redo');   // mac
  assert.equal(c('Ctrl+y'), 'redo');         // windows / linux
});

test('editingCommandFor ignores everything else', () => {
  const c = (s: string) => editingCommandFor(parseKeyCombo(s));
  assert.equal(c('Shift+Tab'), null);
  assert.equal(c('Meta+ArrowLeft'), null);
  assert.equal(c('Alt+v'), null);            // 수식키가 없다
  assert.equal(c('Meta+Alt+v'), null);       // Alt 가 섞이면 다른 조작이다
  assert.equal(c('Meta+Shift+v'), null);
  assert.equal(c('v'), null);
});

test('virtualKeyCode and keyCodeName cover the editing keys', () => {
  assert.equal(virtualKeyCode('v'), 86);
  assert.equal(virtualKeyCode('c'), 67);
  assert.equal(virtualKeyCode('a'), 65);
  assert.equal(keyCodeName('v'), 'KeyV');
  assert.equal(keyCodeName('Z'), 'KeyZ');
});
