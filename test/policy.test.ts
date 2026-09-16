import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPolicy, domainAllowed, looksDestructive, describePolicy, type Policy } from '../src/core/policy.js';
import { buildRules, buildBlockRules } from '../src/core/header-ext.js';

// 세션 정책 (#214). CLI 층이 argv 만 보고 무엇을 거절하는가 — 판단이 아니라 정책이다.

test('domainAllowed — 부분 도메인은 하위 전부, *. 도 같은 뜻', () => {
  assert.ok(domainAllowed('a.com', ['a.com'])); assert.ok(domainAllowed('x.a.com', ['a.com'])); assert.ok(domainAllowed('x.a.com', ['*.a.com']));
  assert.ok(!domainAllowed('a.com.evil', ['a.com'])); assert.ok(!domainAllowed('notacom', ['a.com'])); assert.ok(domainAllowed('A.COM', ['a.com']));
});

test('read-only — 페이지를 바꾸는 명령만, eval 은 --allow-eval 로', () => {
  const p: Policy = { readOnly: true };
  assert.match(checkPolicy(p, { command: 'click', argv: ['button', 'Go'] })!.message, /read-only/);
  assert.equal(checkPolicy(p, { command: 'snapshot', argv: [] }), null);
  assert.equal(checkPolicy(p, { command: 'expect', argv: ['text', 'x'] }), null);
  assert.equal(checkPolicy(p, { command: 'nav', argv: ['https://a'] }), null);
  assert.match(checkPolicy(p, { command: 'eval', argv: ['1'] })!.message, /--allow-eval/);
  assert.equal(checkPolicy(p, { command: 'eval', argv: ['1'], allowEval: true }), null);
});

test('allowDomains — nav · new · ensure url 의 URL 만 본다', () => {
  const p: Policy = { allowDomains: ['a.com'] };
  assert.equal(checkPolicy(p, { command: 'nav', argv: ['https://x.a.com/p'] }), null);
  assert.match(checkPolicy(p, { command: 'nav', argv: ['https://b.com/'] })!.message, /b\.com is outside --allow/);
  assert.match(checkPolicy(p, { command: 'ensure', argv: ['url', 'https://b.com'] })!.message, /outside/);
  assert.equal(checkPolicy(p, { command: 'click', argv: ['link', 'b.com'] }), null, '클릭 뒤의 이동은 브라우저 층이 막는다');
  assert.equal(checkPolicy(p, { command: 'nav', argv: ['file:///x.html'] }), null, 'file: 은 도메인이 아니다');
});

test('confirm destructive — role+이름과 @N 의 저장된 이름을 본다, --confirm 이면 통과', () => {
  const p: Policy = { confirmDestructive: true };
  assert.match(checkPolicy(p, { command: 'click', argv: ['button', 'Delete account'] })!.message, /looks destructive \(Delete\)/);
  assert.match(checkPolicy(p, { command: 'click', argv: ['button', '계정 삭제'] })!.message, /삭제/);
  assert.equal(checkPolicy(p, { command: 'click', argv: ['button', 'Save'] }), null);
  assert.equal(checkPolicy(p, { command: 'click', argv: ['button', 'Delete account'], confirmed: true }), null);
  assert.match(checkPolicy(p, { command: 'click', argv: ['@7'], nameOfRef: () => 'Remove item' })!.message, /Remove/);
  assert.equal(checkPolicy(p, { command: 'click', argv: ['#danger'] }), null, '셀렉터 뒤의 이름은 모른다 — 문서에 적힌 한계');
  assert.match(checkPolicy(p, { command: 'ensure', argv: ['button', 'Pay now', 'focused'] })!.message, /pay/i);
  assert.equal(checkPolicy(p, { command: 'press', argv: ['Enter'] }), null);
});

test('사용자 정규식이 목록에 덧붙는다', () => {
  assert.equal(looksDestructive('Archive all', 'archive'), 'Archive');
  assert.equal(looksDestructive('Archive all'), null);
  assert.equal(looksDestructive('x', '('), null, '틀린 정규식은 무시');
});

test('ls 표기', () => {
  assert.equal(describePolicy(undefined), '-');
  assert.equal(describePolicy({ allowDomains: ['a.com', 'b.com'], readOnly: true, confirmDestructive: true }), 'allow:a.com,b.com read-only confirm-destructive');
});

test('dNR 차단 규칙 — 허용 밖 전부, 헤더 규칙 뒤 id', () => {
  const rules = buildRules([{ name: 'x-a', value: '1' }], ['a.com', '*.b.com']) as Array<{ id: number; action: { type: string }; condition: { excludedRequestDomains?: string[] } }>;
  assert.equal(rules.length, 2);
  assert.equal(rules[1].id, 2); assert.equal(rules[1].action.type, 'block');
  assert.deepEqual(rules[1].condition.excludedRequestDomains, ['a.com', 'b.com']);
  assert.deepEqual(buildBlockRules([], 1), []);
});
