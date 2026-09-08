import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, firstLine } from '../src/commands/inject.js';

// id 는 소스에서 나온다. 같은 스크립트를 두 번 넣으면 같은 id 가 되어 두 벌이 되지
// 않는다 — 훅이 두 번 걸리면 래핑이 겹치고, 그것이 #155 에서 터진 모양이다.
test('같은 소스는 같은 id, 다른 소스는 다른 id', () => {
  assert.equal(idOf('window.a = 1'), idOf('window.a = 1'));
  assert.notEqual(idOf('window.a = 1'), idOf('window.a = 2'));
});

test('id 는 짧고 손으로 칠 수 있는 길이다', () => {
  assert.match(idOf('x'), /^[0-9a-f]{8}$/);
});

// ls 는 무엇이 심겨 있는지 알아보게 하는 것이 전부다. 앞의 빈 줄을 그대로 찍으면
// 목록에 빈 칸만 남는다.
test('첫 줄은 앞의 빈 줄을 건너뛴다', () => {
  assert.equal(firstLine('\n\n  window.a = 1\nwindow.b = 2'), 'window.a = 1');
});

test('긴 줄은 잘리되 잘렸다고 보인다', () => {
  const line = firstLine('x'.repeat(100), 10);
  assert.equal(line.length, 10);
  assert.ok(line.endsWith('…'));
});

test('빈 소스는 빈 문자열이 되고 던지지 않는다', () => {
  assert.equal(firstLine('\n\n   \n'), '');
});
