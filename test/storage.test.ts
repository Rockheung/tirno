import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileWaypointStore, FileTrailStore } from '../src/storage/file-backend.js';
import type { WaypointRecord } from '../src/storage/types.js';

let TMP: string;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-storage-test-'));
  process.env.TIRNO_CACHE_DIR = TMP;
  process.env.TIRNO_TRAILS_DIR = path.join(TMP, 'trails');
});

after(() => {
  delete process.env.TIRNO_CACHE_DIR;
  delete process.env.TIRNO_TRAILS_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  if (fs.existsSync(TMP)) {
    for (const e of fs.readdirSync(TMP)) {
      fs.rmSync(path.join(TMP, e), { recursive: true, force: true });
    }
  }
});

const sample = (overrides: Partial<WaypointRecord> = {}): WaypointRecord => ({
  id: '@1',
  refId: '@1',
  channels: {
    a11y: { role: 'button', name: 'Submit' },
    dom: { selector: '#submit' },
    visual: { bbox: { x: 10, y: 20, w: 100, h: 30 } },
  },
  url: 'https://example.com/',
  urlPath: '/',
  domain: 'example.com',
  viewport: { w: 1920, h: 1080, dpr: 1 },
  capturedAt: new Date().toISOString(),
  searchText: 'button submit #submit',
  ...overrides,
});

test('file: save and get roundtrip', async () => {
  const s = new FileWaypointStore();
  await s.save(sample());
  const got = await s.get('@1');
  assert.ok(got);
  assert.equal(got!.channels.a11y?.name, 'Submit');
  assert.equal(got!.channels.dom?.selector, '#submit');
});

test('file: query by domain', async () => {
  const s = new FileWaypointStore();
  await s.save(sample({ id: '@a', url: 'https://a.com/', domain: 'a.com', urlPath: '/' }));
  await s.save(sample({ id: '@b', url: 'https://b.com/', domain: 'b.com', urlPath: '/' }));
  const onlyA = await s.query({ domain: 'a.com' });
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].domain, 'a.com');
});

test('file: query by role', async () => {
  const s = new FileWaypointStore();
  await s.save(sample({
    id: '@btn',
    channels: { a11y: { role: 'button', name: 'A' } },
  }));
  await s.save(sample({
    id: '@link',
    url: 'https://example.com/x', urlPath: '/x',
    channels: { a11y: { role: 'link', name: 'B' } },
  }));
  const buttons = await s.query({ role: 'button' });
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].channels.a11y?.role, 'button');
});

test('file: search free-text in searchText (auto-built from channels)', async () => {
  const s = new FileWaypointStore();
  await s.save(sample({
    id: '@x',
    channels: { a11y: { role: 'button', name: 'Submit form' } },
  }));
  await s.save(sample({
    id: '@y',
    url: 'https://example.com/y', urlPath: '/y',
    channels: { a11y: { role: 'button', name: 'Cancel' } },
  }));
  const found = await s.query({ search: 'submit' });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, '@x');
});

test('file: query limit', async () => {
  const s = new FileWaypointStore();
  for (let i = 0; i < 5; i++) {
    await s.save(sample({
      id: `@${i}`,
      url: `https://example.com/${i}`,
      urlPath: `/${i}`,
    }));
  }
  const limited = await s.query({ limit: 2 });
  assert.equal(limited.length, 2);
});

test('file: delete by id', async () => {
  const s = new FileWaypointStore();
  await s.save(sample({ id: '@gone' }));
  await s.delete('@gone');
  const got = await s.get('@gone');
  assert.equal(got, null);
});

test('file: trail save/get/query/delete', async () => {
  const ts = new FileTrailStore();
  await ts.save({
    name: 'test1',
    goal: 'do something',
    startUrl: 'https://example.com/',
    capturedAt: new Date().toISOString(),
    durationMs: 1000,
    steps: [],
  });
  const got = await ts.get('test1');
  assert.ok(got);
  assert.equal(got!.goal, 'do something');

  const queried = await ts.query({ goal: 'something' });
  assert.equal(queried.length, 1);

  await ts.delete('test1');
  assert.equal(await ts.get('test1'), null);
});

test('file: trail filter by minSuccessRate', async () => {
  const ts = new FileTrailStore();
  await ts.save({
    name: 'reliable',
    goal: 'a',
    startUrl: 'https://example.com/',
    capturedAt: new Date().toISOString(),
    durationMs: 100,
    steps: [],
    matchStats: { runCount: 10, successCount: 9 },
  });
  await ts.save({
    name: 'flaky',
    goal: 'b',
    startUrl: 'https://example.com/',
    capturedAt: new Date().toISOString(),
    durationMs: 100,
    steps: [],
    matchStats: { runCount: 10, successCount: 3 },
  });
  const stable = await ts.query({ minSuccessRate: 0.8 });
  assert.equal(stable.length, 1);
  assert.equal(stable[0].name, 'reliable');
});
