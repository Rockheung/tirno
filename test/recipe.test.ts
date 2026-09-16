import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as recipes from '../src/core/recipe-store.js';
import { stripSession, derefArgv } from '../src/commands/recipe.js';
import * as refs from '../src/core/ref-store.js';

// 레시피 (#211). 여기서 잠그는 것은 (1) 비밀이 파일에 안 남는다 — 기록 때 가리고 실행 때
// 푼다, (2) @N 은 기록 때 role+이름으로 바뀐다, (3) 세션 옵션은 빠진다, (4) 이름이 여러
// 도메인에 있으면 고르지 않고 묻는다. Chrome 은 안 띄운다.

let tmp: string; let saved: string | undefined;
beforeEach(() => { saved = process.env['TIRNO_DIR']; tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-recipe-')); process.env['TIRNO_DIR'] = tmp; });
afterEach(() => { if (saved === undefined) delete process.env['TIRNO_DIR']; else process.env['TIRNO_DIR'] = saved; fs.rmSync(tmp, { recursive: true, force: true }); });

test('maskVars — 환경변수 값과 같은 인자만 $NAME 으로, 값은 남지 않는다', () => {
  const env = { EMAIL: 'me@x.com', PW: 'hunter2', SHORT: 'a' };
  assert.deepEqual(recipes.maskVars(['fill', 'textbox', 'Email', 'me@x.com'], ['EMAIL', 'PW'], env), ['fill', 'textbox', 'Email', '$EMAIL']);
  assert.deepEqual(recipes.maskVars(['fill', 'textbox', 'Password', 'hunter2'], ['EMAIL', 'PW'], env), ['fill', 'textbox', 'Password', '$PW']);
  // 한 글자 값은 가리지 않는다 — 'a' 를 전부 $SHORT 로 바꾸면 명령이 망가진다
  assert.deepEqual(recipes.maskVars(['press', 'a'], ['SHORT'], env), ['press', 'a']);
});

test('expandVars — NAME=value 가 환경변수보다 먼저, 없으면 던진다, 문장 속 $ 는 건드리지 않는다', () => {
  const env = { EMAIL: 'env@x' };
  assert.deepEqual(recipes.expandVars(['fill', '$EMAIL'], {}, env), ['fill', 'env@x']);
  assert.deepEqual(recipes.expandVars(['fill', '${EMAIL}'], { EMAIL: 'arg@x' }, env), ['fill', 'arg@x']);
  assert.throws(() => recipes.expandVars(['fill', '$PW'], {}, env), /recipe needs PW/);
  assert.deepEqual(recipes.expandVars(['type', 'costs $5'], {}, env), ['type', 'costs $5']);
});

test('parseRunVars — NAME=value 와 나머지', () => {
  assert.deepEqual(recipes.parseRunVars(['EMAIL=a@b', 'PW=x=y', 'oops']), { values: { EMAIL: 'a@b', PW: 'x=y' }, rest: ['oops'] });
});

test('stripSession — -s · --session · --session= 를 뺀다', () => {
  assert.deepEqual(stripSession(['click', '@3', '-s', 'x']), ['click', '@3']);
  assert.deepEqual(stripSession(['--session', 'x', 'click', '@3']), ['click', '@3']);
  assert.deepEqual(stripSession(['click', '--session=x', '@3']), ['click', '@3']);
});

test('derefArgv — @N 은 ref store 의 role+이름으로, 이름이 없으면 그대로 두고 경고', () => {
  const store: refs.RefStore = { ...refs.emptyStore(), refs: { '7': { backendId: 1, role: 'button', name: 'Sign in' }, '9': { backendId: 2, role: 'textbox', name: '' }, '3': { backendId: 3, role: 'StaticText', name: 'Hi' } } };
  assert.deepEqual(derefArgv(['click', '@7'], store), { argv: ['click', 'button', 'Sign in'], from: '@7' });
  assert.deepEqual(derefArgv(['click', '@3'], store).argv, ['click', 'text', 'Hi']);
  const r = derefArgv(['fill', '@9', 'x'], store);
  assert.deepEqual(r.argv, ['fill', '@9', 'x']); assert.match(r.warning!, /no accessible name/);
  assert.match(derefArgv(['click', '@99'], store).warning!, /not in the ref store/);
  assert.deepEqual(derefArgv(['click', '#btn'], store), { argv: ['click', '#btn'] });
});

test('저장·목록·찾기 — 같은 이름이 두 도메인이면 묻는다', () => {
  const base = { schemaVersion: 1, vars: [], steps: [{ argv: ['click', 'button', 'x'], at: 't' }], recordedAt: 't', runs: { ok: 0, failed: 0 } };
  recipes.save({ ...base, name: 'login', domain: 'a.com' });
  recipes.save({ ...base, name: 'login', domain: 'b.com' });
  recipes.save({ ...base, name: 'only', domain: 'a.com' });
  assert.deepEqual(recipes.list().map(r => `${r.domain}/${r.name}`), ['a.com/login', 'a.com/only', 'b.com/login']);
  assert.equal(recipes.find('login', 'b.com').domain, 'b.com');
  assert.equal(recipes.find('only').domain, 'a.com');
  assert.throws(() => recipes.find('login'), /exists for 2 domains/);
  assert.throws(() => recipes.find('nope'), /no recipe named/);
  assert.ok(recipes.remove('a.com', 'only')); assert.ok(!recipes.remove('a.com', 'only'));
});

test('domainOf — file: 은 local', () => {
  assert.equal(recipes.domainOf('https://app.example.com/x?y'), 'app.example.com');
  assert.equal(recipes.domainOf('file:///tmp/a.html'), 'local');
  assert.equal(recipes.domainOf(''), 'local');
});
