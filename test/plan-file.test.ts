import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parsePlan, planFromRecipe } from '../src/core/plan-file.js';
import { masker, firstLine } from '../src/core/step-runner.js';

// 계획 파일 (#212). 단계는 argv 배열이거나 한 줄 문자열 — 문자열은 셸처럼 따옴표를 존중한다.

test('tokenize — 따옴표 안의 공백은 한 인자, 이스케이프, 빈 인자', () => {
  assert.deepEqual(tokenize('click button "Sign in"'), ['click', 'button', 'Sign in']);
  assert.deepEqual(tokenize("fill textbox 'Full name' 'Ada Lovelace'"), ['fill', 'textbox', 'Full name', 'Ada Lovelace']);
  assert.deepEqual(tokenize('expect text "say \\"hi\\""'), ['expect', 'text', 'say "hi"']);
  assert.deepEqual(tokenize('fill textbox Email ""'), ['fill', 'textbox', 'Email', '']);
  assert.deepEqual(tokenize('  ensure   url  https://a/b  '), ['ensure', 'url', 'https://a/b']);
  assert.throws(() => tokenize('click "open'), /unclosed/);
});

test('parsePlan — 문자열과 배열이 섞여도 된다, 빈 단계·비JSON 은 거절', () => {
  const p = parsePlan(JSON.stringify({ session: 's', vars: ['X'], startUrl: 'https://a', steps: ['click button Go', ['expect', 'text', 'done']] }), 'f.json');
  assert.equal(p.session, 's'); assert.deepEqual(p.vars, ['X']); assert.equal(p.startUrl, 'https://a');
  assert.deepEqual(p.steps, [['click', 'button', 'Go'], ['expect', 'text', 'done']]);
  assert.throws(() => parsePlan('{"steps": []}', 'f'), /non-empty/);
  assert.throws(() => parsePlan('{"steps": [""]}', 'f'), /step 1 is empty/);
  assert.throws(() => parsePlan('nope', 'f'), /not JSON/);
  assert.throws(() => parsePlan('{"steps": [42]}', 'f'), /step 1 must be/);
});

test('레시피는 계획이다', () => {
  const p = planFromRecipe({ schemaVersion: 1, name: 'login', domain: 'a.com', vars: ['PW'], startUrl: 'https://a.com/login', steps: [{ argv: ['click', 'button', 'Go'], at: 't' }], recordedAt: 't', runs: { ok: 0, failed: 0 } });
  assert.equal(p.name, 'a.com/login'); assert.deepEqual(p.steps, [['click', 'button', 'Go']]); assert.equal(p.startUrl, 'https://a.com/login');
});

test('masker — 두 글자 이상만, 전부', () => {
  const m = masker(['hunter2', 'a', '']);
  assert.equal(m('pw hunter2 and hunter2 again a'), 'pw •••• and •••• again a');
});

test('firstLine — ✓/✗ 줄을 고르고 표식을 뗀다', () => {
  assert.equal(firstLine('→ note\n✓ Clicked button "Go"\n  +1 x'), 'Clicked button "Go"');
  assert.equal(firstLine('→ only'), '→ only');
});
