import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRules, buildView, writeHeaderExt, headerExtDir } from '../src/core/header-ext.js';

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

// ── 창 안에서 보이게 하는 쪽 (#167).
//
// 헤더가 결과를 가르는 환경에서 헤더 유무가 화면에 안 드러나면 엉뚱한 대상을 재고도
// 모른다. 규칙이 브라우저 네트워크 스택에 있다는 것이 장점이자 그대로 문제였다 —
// 창에는 아무 흔적이 없다.

test('매니페스트가 팝업과 배경 워커를 건다', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-hdrtest-'));
  try {
    const dir = writeHeaderExt(profile, [{ name: 'X-A', value: '1' }]);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.action.default_popup, 'popup.html');
    assert.equal(manifest.background.service_worker, 'bg.js');
    // 권한은 늘지 않아야 한다 — MV3 의 chrome.action 은 권한을 요구하지 않고,
    // 팝업은 자기 확장 안의 파일만 읽는다. 늘었다면 UI 가 규칙의 대가를 키운 것이다.
    assert.deepEqual(manifest.permissions, ['declarativeNetRequest']);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('매니페스트가 가리키는 UI 파일이 전부 실제로 있다', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-hdrtest-'));
  try {
    const dir = writeHeaderExt(profile, [{ name: 'X-A', value: '1' }]);
    for (const f of ['bg.js', 'popup.html', 'popup.css', 'popup.js', 'view.json']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${f} 가 없다`);
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

// 팝업이 읽는 표는 DNR 형식과 따로 둔다 — rules.json 의 형식이 바뀌어도 팝업이
// 따라 깨지지 않아야 한다.
test('view 는 호스트 없는 규칙을 null 로 적는다', () => {
  const [all, scoped] = buildView([
    { name: 'X-A', value: '1' },
    { name: 'X-B', value: '2', hosts: ['a.com'] },
  ]) as Array<Record<string, unknown>>;
  assert.deepEqual(all, { name: 'X-A', value: '1', hosts: null });
  assert.deepEqual(scoped, { name: 'X-B', value: '2', hosts: ['a.com'] });
});

// 뱃지는 view.json 의 길이다. 규칙을 지웠는데 view 가 남으면 뱃지가 규칙보다
// 낡아서, 이 기능이 고치려던 바로 그 오독을 다시 만든다.
test('규칙을 비우면 view 도 함께 빈다', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-hdrtest-'));
  try {
    writeHeaderExt(profile, [{ name: 'X-A', value: '1' }]);
    const dir = writeHeaderExt(profile, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'view.json'), 'utf-8')), []);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

// MV3 의 확장 CSP 는 인라인 스크립트를 거부한다. 인라인으로 쓰면 팝업이 조용히
// 빈 채로 뜬다 — 확장 로드는 성공하므로 어디에도 에러가 안 난다.
test('팝업은 인라인 스크립트를 쓰지 않는다', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-hdrtest-'));
  try {
    const dir = writeHeaderExt(profile, [{ name: 'X-A', value: '1' }]);
    const html = fs.readFileSync(path.join(dir, 'popup.html'), 'utf-8');
    assert.match(html, /<script src="popup\.js"><\/script>/);
    assert.doesNotMatch(html, /<script>[^<]/, '인라인 스크립트가 있다');
    assert.doesNotMatch(html, /\son\w+=/, '인라인 이벤트 핸들러가 있다');
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
