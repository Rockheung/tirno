import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPrefs, expectsExtension, checkExtensions } from '../src/core/drift-axes.js';
import type { SessionMetadata } from '../src/core/session-store.js';
import type { Browser } from '../src/cdp/browser.js';

// drift 의 다른 축 (#192). Chrome 은 안 띄운다 — 타깃 목록과 Preferences 는 가짜다.

const meta = (over: Partial<SessionMetadata> = {}): SessionMetadata => ({
  name: 's', pid: 1, port: 1, wsEndpoint: '', userDataDir: '/nope', chromeFlags: [], createdAt: '', lastAccessedAt: '', ...over,
} as SessionMetadata);

const browserWith = (urls: Array<[string, string]>): Browser => ({
  targets: async () => urls.map(([type, url]) => ({ type: () => type, url: () => url })),
} as unknown as Browser);

test('확장을 기대하지 않는 세션은 n/a', async () => {
  const a = await checkExtensions(browserWith([]), meta());
  assert.equal(a.status, 'n/a');
  assert.equal(expectsExtension(meta()), null);
});

test('헤더 규칙이나 허용 목록이 있는데 확장 타깃이 없으면 DRIFT, 있으면 ok', async () => {
  const m = meta({ headerRules: [{ name: 'x', value: '1' }], policy: { allowDomains: ['a.com'] } });
  assert.equal(expectsExtension(m), '1 header rule · allow a.com');
  const drift = await checkExtensions(browserWith([['page', 'https://a.com']]), m);
  assert.equal(drift.status, 'drift'); assert.match(drift.actual, /0 extension targets/); assert.match(drift.fix!, /headers set|restart s/);
  const ok = await checkExtensions(browserWith([['page', 'https://a.com'], ['service_worker', 'chrome-extension://abc/bg.js']]), m);
  assert.equal(ok.status, 'ok');
});

test('prefs — 심은 값이 그대로면 ok, 바뀌었으면 changed-by-user(drift 아님), 못 읽으면 n/a', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-prefs-'));
  try {
    assert.equal(checkPrefs(meta({ userDataDir: dir })).status, 'n/a');
    fs.mkdirSync(path.join(dir, 'Default'));
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ translate: { enabled: false } }));
    assert.equal(checkPrefs(meta({ userDataDir: dir })).status, 'ok');
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ translate: { enabled: true } }));
    const c = checkPrefs(meta({ userDataDir: dir }));
    assert.equal(c.status, 'changed-by-user'); assert.match(c.actual, /someone changed it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
