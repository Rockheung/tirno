import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClause, parseDuration, splitWithin, compare, normalizeEnsure } from '../src/commands/declare.js';
import { isRoleWord, takesName, axRole, findByRoleName } from '../src/cdp/target.js';
import type { CdpSession } from '../src/cdp/client.js';

// ensure/expect 의 문법 (#210). 여기서 잠그는 것은 절 파싱 — 어느 낱말이 role 이고 이름이고
// 비교자인지, within 을 어디서 떼는지 — 와 role+이름 매칭 규칙(부분 일치, 정확 일치 우선).

test('duration: 5s · 500ms · 2m · 맨 숫자는 ms', () => {
  assert.equal(parseDuration('5s')!.ms, 5000);
  assert.equal(parseDuration('500ms')!.ms, 500);
  assert.equal(parseDuration('2m')!.ms, 120000);
  assert.equal(parseDuration('10')!.ms, 10);
  assert.equal(parseDuration('soon'), null);
});

test('within 은 맨 뒤에서만 뗀다 — 이름 속의 within 은 이름이다', () => {
  assert.deepEqual(splitWithin(['text', 'Saved', 'within', '5s']).args, ['text', 'Saved']);
  assert.equal(splitWithin(['text', 'Saved', 'within', '5s']).within!.ms, 5000);
  assert.deepEqual(splitWithin(['text', 'within', 'reach']).args, ['text', 'within', 'reach']);
});

test('url · title: 비교자는 기호도 낱말도 — 셸이 ~ 와 >= 를 먹기 때문', () => {
  assert.deepEqual(pick(parseClause(['url', '~', '/dash'])), { what: 'url', op: '~', value: '/dash' });
  assert.deepEqual(pick(parseClause(['url', 'matches', '/dash'])), { what: 'url', op: '~', value: '/dash' });
  assert.deepEqual(pick(parseClause(['url', 'https://a/b'])), { what: 'url', op: '=', value: 'https://a/b' });
  assert.deepEqual(pick(parseClause(['title', 'is', 'My', 'Page'])), { what: 'title', op: '=', value: 'My Page' });
});

test('count: <selector> <op> <n>', () => {
  const c = parseClause(['count', 'tr.row', 'ge', '3']);
  assert.equal(c.value, 'tr.row'); assert.equal(c.op, '>='); assert.equal(c.name, '3');
});

test('value · checked · focused: role 뒤 이름은 비워도 된다', () => {
  const c = parseClause(['value', 'textbox', 'Email', '=', 'me@x']);
  assert.deepEqual([c.role, c.name, c.op, c.value], ['textbox', 'Email', '=', 'me@x']);
  const noName = parseClause(['checked', 'checkbox']);
  assert.deepEqual([noName.role, noName.name], ['checkbox', undefined]);
  const noNameVal = parseClause(['value', 'combobox', '=', 'B']);
  assert.deepEqual([noNameVal.role, noNameVal.name, noNameVal.value], ['combobox', undefined, 'B']);
  assert.throws(() => parseClause(['checked', 'notarole']), /needs <role>/);
});

test('visible: role+이름 또는 text', () => {
  assert.deepEqual(pick(parseClause(['visible', 'text', 'Welcome', 'back'])), { what: 'visible', op: 'contains', value: 'Welcome back' });
  const c = parseClause(['hidden', 'dialog', 'Cookies']);
  assert.deepEqual([c.what, c.role, c.name], ['hidden', 'dialog', 'Cookies']);
});

test('ensure 의 줄임 — role 로 시작하면 value, 끝이 checked/unchecked/focused 면 그것', () => {
  assert.equal(normalizeEnsure(['textbox', 'Email', '=', 'x']).what, 'value');
  assert.equal(normalizeEnsure(['checkbox', 'Remember', 'checked']).what, 'checked');
  assert.equal(normalizeEnsure(['checkbox', 'checked']).what, 'checked');
  const w = normalizeEnsure(['checkbox', 'Remember', 'checked', 'within', '3s']);
  assert.equal(w.what, 'checked'); assert.equal(w.within!.ms, 3000);
  assert.equal(normalizeEnsure(['url', 'https://x']).what, 'url');
});

test('compare', () => {
  assert.ok(compare('~', 'https://a/dash?x', '/dash'));
  assert.ok(compare('>=', 3, '3')); assert.ok(!compare('>', 3, '3'));
  assert.ok(compare('contains', 'hello world', 'lo w'));
  assert.ok(compare('!=', 'a', 'b'));
});

test('role 낱말과 별칭', () => {
  assert.ok(isRoleWord('button')); assert.ok(isRoleWord('Textbox')); assert.ok(!isRoleWord('#btn'));
  assert.equal(axRole('text'), 'StaticText'); assert.equal(axRole('img'), 'image'); assert.equal(axRole('button'), 'button');
  assert.ok(takesName('link')); assert.ok(!takesName('@3')); assert.ok(!takesName('10,20'));
});

function fakeAx(nodes: Array<{ name: string; id: number; ignored?: boolean }>): CdpSession {
  return {
    send: async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { backendNodeId: 1 } };
      return { nodes: nodes.map(n => ({ backendDOMNodeId: n.id, ignored: n.ignored ?? false, name: { value: n.name }, role: { value: 'button' } })) };
    },
  } as unknown as CdpSession;
}

test('이름은 부분·대소문자 무시, 정확히 같은 것이 하나면 그것 — "Save" vs "Save draft"', async () => {
  const cdp = fakeAx([{ name: 'Save draft', id: 1 }, { name: 'Save', id: 2 }, { name: 'Save and close', id: 3 }, { name: 'Cancel', id: 4 }]);
  assert.deepEqual((await findByRoleName(cdp, 'button', 'save', false)).map(c => c.backendNodeId), [2]);
  assert.deepEqual((await findByRoleName(cdp, 'button', 'sav', false)).map(c => c.backendNodeId), [1, 2, 3]);
  assert.deepEqual((await findByRoleName(cdp, 'button', 'Save', true)).map(c => c.backendNodeId), [2]);
  assert.deepEqual((await findByRoleName(cdp, 'button', 'save', true)).map(c => c.backendNodeId), [], '--exact 는 대소문자도 본다');
  assert.equal((await findByRoleName(cdp, 'button', undefined, false)).length, 4, '이름이 없으면 role 전부');
});

test('ignored 노드는 후보가 아니다', async () => {
  const cdp = fakeAx([{ name: 'Hidden', id: 1, ignored: true }, { name: 'Shown', id: 2 }]);
  assert.deepEqual((await findByRoleName(cdp, 'button', undefined, false)).map(c => c.backendNodeId), [2]);
});

function pick(c: ReturnType<typeof parseClause>) {
  return { what: c.what, op: c.op, value: c.value };
}
