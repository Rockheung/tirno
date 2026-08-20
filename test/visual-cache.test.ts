import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as cache from '../src/core/visual-cache.js';

let TMP: string;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-cache-test-'));
  process.env.TIRNO_CACHE_DIR = TMP;
});

after(() => {
  delete process.env.TIRNO_CACHE_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  // wipe between tests
  if (fs.existsSync(TMP)) {
    for (const e of fs.readdirSync(TMP)) {
      fs.rmSync(path.join(TMP, e), { recursive: true, force: true });
    }
  }
});

const fixtureEntry = (overrides: Partial<cache.CacheEntry> = {}): cache.CacheEntry => ({
  url: 'https://example.com/foo?q=1',
  urlPath: '/foo?q=1',
  domain: 'example.com',
  capturedAt: new Date().toISOString(),
  visualFp: '0123456789abcdef',
  viewport: { w: 1200, h: 800, dpr: 2 },
  refs: [
    { refId: '@1', role: 'button', name: 'Submit', selector: '#submit' },
  ],
  ...overrides,
});

test('parseUrl extracts domain, path, query, hash', () => {
  const k = cache.parseUrl('https://www.example.com/foo/bar?q=hi&page=2#section');
  assert.equal(k.domain, 'www.example.com');
  assert.equal(k.urlPath, '/foo/bar?q=hi&page=2#section');
  assert.equal(k.fullUrl, 'https://www.example.com/foo/bar?q=hi&page=2#section');
});

test('parseUrl with bare path', () => {
  const k = cache.parseUrl('https://example.com');
  assert.equal(k.urlPath, '/');
});

test('parseUrl distinguishes different queries', () => {
  const a = cache.parseUrl('https://example.com/search?q=foo');
  const b = cache.parseUrl('https://example.com/search?q=bar');
  assert.notEqual(a.urlPath, b.urlPath);
});

test('save and lookup roundtrip (urlPath mode)', () => {
  const e = fixtureEntry();
  cache.save(e);
  const got = cache.lookup(e.url);
  assert.deepEqual(got, e);
});

test('lookup urlPath mode ignores origin difference', () => {
  const e = fixtureEntry({
    url: 'https://example.com/foo?q=1',
    urlPath: '/foo?q=1',
    domain: 'example.com',
  });
  cache.save(e);
  // different origin (http vs https) — same domain+urlPath → urlPath mode hits
  const got = cache.lookup('http://example.com/foo?q=1', 'urlPath');
  assert.ok(got);
  assert.equal(got!.urlPath, '/foo?q=1');
});

test('lookup exact mode requires full URL match', () => {
  const e = fixtureEntry();
  cache.save(e);
  assert.ok(cache.lookup(e.url, 'exact'));
  // different scheme → exact miss
  const miss = cache.lookup('http://example.com/foo?q=1', 'exact');
  assert.equal(miss, null);
});

test('lookup miss for unknown URL', () => {
  assert.equal(cache.lookup('https://nowhere.example.com/'), null);
});

test('different query strings → separate entries', () => {
  cache.save(fixtureEntry({ url: 'https://example.com/s?q=foo', urlPath: '/s?q=foo' }));
  cache.save(fixtureEntry({ url: 'https://example.com/s?q=bar', urlPath: '/s?q=bar' }));
  const all = cache.list();
  assert.equal(all.length, 2);
});

test('list returns entries sorted by capturedAt desc', () => {
  cache.save(fixtureEntry({ url: 'https://example.com/old', urlPath: '/old', capturedAt: '2026-01-01T00:00:00.000Z' }));
  cache.save(fixtureEntry({ url: 'https://example.com/new', urlPath: '/new', capturedAt: '2026-05-05T00:00:00.000Z' }));
  const all = cache.list();
  assert.equal(all[0].urlPath, '/new');
  assert.equal(all[1].urlPath, '/old');
});

test('list with domain filter', () => {
  cache.save(fixtureEntry({ url: 'https://a.com/', urlPath: '/', domain: 'a.com' }));
  cache.save(fixtureEntry({ url: 'https://b.com/', urlPath: '/', domain: 'b.com' }));
  const onlyA = cache.list({ domain: 'a.com' });
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].domain, 'a.com');
});

test('list with limit', () => {
  for (let i = 0; i < 5; i++) {
    cache.save(fixtureEntry({ url: `https://example.com/p${i}`, urlPath: `/p${i}` }));
  }
  assert.equal(cache.list({ limit: 3 }).length, 3);
});

test('prune all removes everything', () => {
  cache.save(fixtureEntry());
  const { removed } = cache.prune();
  assert.equal(removed, 1);
  assert.equal(cache.list().length, 0);
});

test('prune --older-than keeps fresh entries', () => {
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  cache.save(fixtureEntry({ url: 'https://example.com/fresh', urlPath: '/fresh', capturedAt: fresh }));
  cache.save(fixtureEntry({ url: 'https://example.com/old', urlPath: '/old', capturedAt: old }));
  const { removed } = cache.prune({ olderThanDays: 30 });
  assert.equal(removed, 1);
  const remaining = cache.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].urlPath, '/fresh');
});

test('prune --domain only affects target domain', () => {
  cache.save(fixtureEntry({ url: 'https://a.com/', urlPath: '/', domain: 'a.com' }));
  cache.save(fixtureEntry({ url: 'https://b.com/', urlPath: '/', domain: 'b.com' }));
  cache.prune({ domain: 'a.com' });
  const remaining = cache.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].domain, 'b.com');
});

test('list returns empty when cache dir does not exist', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.deepEqual(cache.list(), []);
  fs.mkdirSync(TMP, { recursive: true });
});
