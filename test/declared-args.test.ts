import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredArgs } from '../src/core/chrome-launcher.js';

// 기본 플래그 뒤에 사용자 플래그를 그대로 붙여, 같은 플래그가 장부에 두 번 실렸다(#234).
// chrome 은 마지막 값을 쓰니 동작은 같았지만 export 가독성과 drift 비교의 문제였다.

test('사용자가 같은 플래그를 주면 기본값을 대체하고 한 번만 남는다', () => {
  const args = declaredArgs(0, ['--window-size=1280,720', '--no-sandbox']);
  assert.deepEqual(args.filter(f => f.startsWith('--window-size')), ['--window-size=1280,720']);
  assert.ok(args.includes('--no-sandbox'));
  // 값이 기본값과 같아도 두 번은 아니다 — 이슈의 재현 그대로
  assert.equal(declaredArgs(0, ['--window-size=1920,1080']).filter(f => f.startsWith('--window-size')).length, 1);
});

test('사용자 플래그가 없으면 기본 다섯이 그대로다', () => {
  assert.deepEqual(declaredArgs(9222, []), [
    '--remote-debugging-port=9222', '--no-first-run', '--no-default-browser-check',
    '--window-size=1920,1080', '--window-position=0,0',
  ]);
});
