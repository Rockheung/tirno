import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRules, writeHeaderExt, headerExtDir } from '../src/core/header-ext.js';

// declarativeNetRequest 가 어긋난 규칙을 조용히 버리는 것이 이 파일의 존재 이유다 —
// 잘못 만든 규칙은 확장 로드도 성공하고 에러도 내지 않으므로, 형태가 틀린 것은
// 브라우저가 아니라 여기서 잡혀야 한다.

test('a rule with no hosts matches every request', () => {
  const [rule] = buildRules([{ name: 'X-A', value: '1' }]) as Array<Record<string, any>>;
  assert.equal(rule.condition.urlFilter, '*');
  assert.equal(rule.condition.requestDomains, undefined);
  assert.deepEqual(rule.action.requestHeaders, [{ header: 'X-A', operation: 'set', value: '1' }]);
});

test('hosts become requestDomains and drop the catch-all filter', () => {
  const [rule] = buildRules([{ name: 'X-A', value: '1', hosts: ['a.com', 'b.com'] }]) as Array<Record<string, any>>;
  assert.deepEqual(rule.condition.requestDomains, ['a.com', 'b.com']);
  assert.equal(rule.condition.urlFilter, undefined);
});

// 규칙 id 는 1부터의 정수여야 한다. 0 이나 중복이면 그 규칙만 무효가 된다.
test('rule ids start at 1 and stay unique', () => {
  const rules = buildRules([
    { name: 'X-A', value: '1' }, { name: 'X-B', value: '2' }, { name: 'X-C', value: '3' },
  ]) as Array<{ id: number }>;
  assert.deepEqual(rules.map(r => r.id), [1, 2, 3]);
});

// main_frame 이 빠지면 navigation 에 안 붙고, xmlhttprequest 가 빠지면 페이지가
// 스스로 보내는 요청에 안 붙는다 — 둘 다 이 기능의 요점이다.
test('every rule covers navigation and page-initiated requests', () => {
  for (const r of buildRules([{ name: 'X-A', value: '1' }]) as Array<Record<string, any>>) {
    assert.ok(r.condition.resourceTypes.includes('main_frame'));
    assert.ok(r.condition.resourceTypes.includes('xmlhttprequest'));
    assert.ok(r.condition.resourceTypes.includes('sub_frame'));
  }
});

test('writeHeaderExt bakes a loadable extension into the profile', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-hdrtest-'));
  try {
    const dir = writeHeaderExt(profile, [{ name: 'X-A', value: '1', hosts: ['a.com'] }]);
    assert.equal(dir, headerExtDir(profile));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['declarativeNetRequest']);
    // 매니페스트가 가리키는 규칙 파일이 실제로 그 이름으로 있어야 한다.
    assert.equal(manifest.declarative_net_request.rule_resources[0].path, 'rules.json');
    const rules = JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf-8'));
    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0].condition.requestDomains, ['a.com']);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('clearing every rule leaves an empty rule file, not a stale one', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-hdrtest-'));
  try {
    writeHeaderExt(profile, [{ name: 'X-A', value: '1' }]);
    const dir = writeHeaderExt(profile, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf-8')), []);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
