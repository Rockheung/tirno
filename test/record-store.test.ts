import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as recStore from '../src/core/record-store.js';

let TMP: string;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-rec-test-'));
  process.env.TIRNO_RECORDINGS_DIR = TMP;
});

after(() => {
  delete process.env.TIRNO_RECORDINGS_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  if (fs.existsSync(TMP)) {
    for (const e of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, e), { recursive: true, force: true });
  }
});

const sample = (overrides: Partial<recStore.Recording> = {}): recStore.Recording => ({
  name: 'test1',
  capturedAt: '2026-05-06T00:00:00.000Z',
  durationMs: 1000,
  startUrl: 'https://example.com/',
  events: [{ type: 'click', t: 100, x: 50, y: 60 }],
  ...overrides,
});

test('save and load roundtrip', () => {
  recStore.save(sample());
  const loaded = recStore.load('test1');
  assert.equal(loaded.name, 'test1');
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0].type, 'click');
});

test('load throws when missing', () => {
  assert.throws(() => recStore.load('nonexistent'), /No recording/);
});

test('list returns all recordings sorted by capturedAt desc', () => {
  recStore.save(sample({ name: 'old', capturedAt: '2026-01-01T00:00:00.000Z' }));
  recStore.save(sample({ name: 'new', capturedAt: '2026-05-05T00:00:00.000Z' }));
  const all = recStore.list();
  assert.equal(all.length, 2);
  assert.equal(all[0].name, 'new');
  assert.equal(all[1].name, 'old');
});

test('list returns empty when dir empty', () => {
  assert.deepEqual(recStore.list(), []);
});

test('remove deletes file', () => {
  recStore.save(sample({ name: 'gone' }));
  assert.equal(recStore.list().length, 1);
  recStore.remove('gone');
  assert.equal(recStore.list().length, 0);
});

test('remove on missing is noop (no throw)', () => {
  assert.doesNotThrow(() => recStore.remove('nope'));
});

test('save rejects unsafe names', () => {
  assert.throws(() => recStore.save(sample({ name: '../etc/passwd' })), /must match/);
  assert.throws(() => recStore.save(sample({ name: 'name with space' })), /must match/);
  assert.throws(() => recStore.save(sample({ name: 'foo/bar' })), /must match/);
});

test('save accepts valid names', () => {
  for (const n of ['simple', 'with-dash', 'with_underscore', 'mix-1_2-3', 'CamelCase']) {
    assert.doesNotThrow(() => recStore.save(sample({ name: n })));
  }
});
