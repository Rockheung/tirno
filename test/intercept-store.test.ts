import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/core/session-store.js';
import * as rules from '../src/core/intercept-store.js';

// 워커는 Chrome 을 물고 있지만 **무엇을 할지 정하는 것은 순수 함수**다. 그 판정이
// 여기서 증명된다 — 실제로 가로채는지는 스모크가 본다.

let tmp: string;
let savedDir: string | undefined;

beforeEach(() => {
  savedDir = process.env['TIRNO_DIR'];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-icept-'));
  process.env['TIRNO_DIR'] = tmp;
  store.create({
    name: 's', pid: 1, port: 1, wsEndpoint: 'ws://x', userDataDir: tmp,
    chromeFlags: [], createdAt: 'now', lastAccessedAt: 'now',
  });
});

afterEach(() => {
  if (savedDir === undefined) delete process.env['TIRNO_DIR'];
  else process.env['TIRNO_DIR'] = savedDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const rule = (over: Partial<rules.InterceptRule> = {}): rules.InterceptRule =>
  ({ id: 'r1', kind: 'block', createdAt: 'now', ...over });

// ── 호스트 glob. 필터가 새면 그것은 필터가 아니라 사고다.

test('a host pattern must match the whole hostname', () => {
  assert.ok(rules.matchesHost('example.com', 'example.com'));
  assert.ok(!rules.matchesHost('evil-example.com.attacker.net', 'example.com'),
    'a substring match here would send headers to an attacker');
  assert.ok(!rules.matchesHost('notexample.com', 'example.com'));
  assert.ok(!rules.matchesHost('example.com.evil', 'example.com'));
});

test('*.example.com is subdomains only', () => {
  assert.ok(rules.matchesHost('api.example.com', '*.example.com'));
  assert.ok(rules.matchesHost('a.b.example.com', '*.example.com'));
  assert.ok(!rules.matchesHost('example.com', '*.example.com'), 'the apex is a different host');
});

test('a dot in the pattern is a literal dot', () => {
  assert.ok(!rules.matchesHost('exampleXcom', 'example.com'));
});

// ── URL glob 은 `net --filter` 와 같은 규칙 — 양끝이 열려 있다.

test('a url pattern matches anywhere, with or without wildcards', () => {
  assert.ok(rules.matchesUrl('https://a.test/ads/banner.png', '/ads/'));
  assert.ok(rules.matchesUrl('https://a.test/ads/banner.png', '*/ads/*.png'));
  assert.ok(!rules.matchesUrl('https://a.test/img/banner.png', '/ads/'));
});

test('a rule with a host condition ignores urls it cannot parse', () => {
  assert.ok(!rules.ruleMatches(rule({ host: 'example.com' }), 'not a url'));
});

test('host and url conditions are ANDed', () => {
  const r = rule({ host: 'example.com', url: '/api/' });
  assert.ok(rules.ruleMatches(r, 'https://example.com/api/x'));
  assert.ok(!rules.ruleMatches(r, 'https://example.com/other'));
  assert.ok(!rules.ruleMatches(r, 'https://other.com/api/x'));
});

// ── resolve. 여기가 실측으로 고친 자리다.

test('the first matching block or mock decides, and later ones do not', () => {
  const out = rules.resolve([
    rule({ id: 'r1', kind: 'block', url: '/x' }),
    rule({ id: 'r2', kind: 'mock', url: '/x', status: 200 }),
  ], 'https://a.test/x');
  assert.equal(out.terminal?.id, 'r1');
  assert.deepEqual(out.matched.map(r => r.id), ['r1']);
});

// 헤더를 붙이는 것은 요청을 끝내지 않는다. 먼저 걸렸다고 뒤의 차단·모킹을 가리면,
// 규칙은 늘었는데 아무 일도 안 일어나고 이유는 안 보인다 — 실측으로 밟은 자리다.
test('a broad header rule does not shadow a later mock', () => {
  const out = rules.resolve([
    rule({ id: 'r1', kind: 'header', host: 'a.test', headers: { 'X-A': '1' } }),
    rule({ id: 'r2', kind: 'mock', url: '/favicon.ico', status: 418 }),
  ], 'https://a.test/favicon.ico');
  assert.equal(out.terminal?.id, 'r2', 'the mock must still win the outcome');
  assert.deepEqual(out.headers, { 'X-A': '1' }, 'and the header must still be applied');
  assert.deepEqual(out.matched.map(r => r.id).sort(), ['r1', 'r2']);
});

test('every matching header rule contributes; the later one wins a clash', () => {
  const out = rules.resolve([
    rule({ id: 'r1', kind: 'header', host: '*.test', headers: { 'X-A': '1', 'X-B': 'first' } }),
    rule({ id: 'r2', kind: 'header', url: '/api/', headers: { 'X-B': 'second' } }),
  ], 'https://a.test/api/x');
  assert.deepEqual(out.headers, { 'X-A': '1', 'X-B': 'second' });
});

test('nothing matching means no headers and no terminal', () => {
  const out = rules.resolve([rule({ url: '/nope' })], 'https://a.test/x');
  assert.equal(out.terminal, null);
  assert.deepEqual(out.headers, {});
  assert.deepEqual(out.matched, []);
});

test('an empty rule list is not an error', () => {
  assert.equal(rules.resolve([], 'https://a.test/').terminal, null);
});

// ── 저장. 규칙은 데몬이 아니라 세션에 산다 — 데몬은 죽어도 규칙은 남아야 한다.

test('rules round-trip through the session, in insertion order', () => {
  rules.add('s', { kind: 'block', url: '/a' });
  rules.add('s', { kind: 'mock', url: '/b', status: 500 });
  assert.deepEqual(rules.list('s').map(r => [r.id, r.kind, r.url]), [
    ['r1', 'block', '/a'],
    ['r2', 'mock', '/b'],
  ]);
});

test('ids are reused only when free, so `rm r1` never hits the wrong rule', () => {
  rules.add('s', { kind: 'block', url: '/a' });
  rules.add('s', { kind: 'block', url: '/b' });
  rules.remove('s', 'r1');
  const added = rules.add('s', { kind: 'block', url: '/c' });
  assert.equal(added.id, 'r1', 'r1 is free again');
  assert.deepEqual(rules.list('s').map(r => r.id), ['r2', 'r1']);
});

test('removing something that is not there says so instead of pretending', () => {
  assert.equal(rules.remove('s', 'r9'), false);
  rules.add('s', { kind: 'block', url: '/a' });
  assert.equal(rules.remove('s', 'r1'), true);
});

test('clear reports how many it removed', () => {
  rules.add('s', { kind: 'block', url: '/a' });
  rules.add('s', { kind: 'block', url: '/b' });
  assert.equal(rules.clear('s'), 2);
  assert.deepEqual(rules.list('s'), []);
});

test('a session with no rules reads as an empty list, not undefined', () => {
  assert.deepEqual(rules.list('s'), []);
});

test('describe names the scope and the effect, for both ls and status', () => {
  assert.match(rules.describe(rule({ kind: 'block', url: '/ads/' })), /block url \/ads\//);
  assert.match(rules.describe(rule({ kind: 'mock', host: 'a.test', status: 503 })), /mock host a\.test → 503/);
  assert.match(
    rules.describe(rule({ kind: 'header', host: 'a.test', headers: { 'X-A': '1' } })),
    /header host a\.test → X-A: 1/,
  );
});
