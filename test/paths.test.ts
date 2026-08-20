import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as refs from '../src/core/ref-store.js';
import * as trails from '../src/core/trail-store.js';
import * as records from '../src/core/record-store.js';
import * as cache from '../src/core/visual-cache.js';
import { writeScreenshot } from '../src/output/image-writer.js';

// `TIRNO_DIR` has to move every store, not most of them. A store that resolves
// its own path from `os.homedir()` writes to the real `~/.tirno` no matter what
// the caller set — and that directory holds profiles (logged-in browser
// sessions) and the visual cache. The smoke suite ran for months believing it
// was isolated while `cache prune --older-than 0` emptied the real cache on
// every run.
//
// These tests do not check "the file landed in the right place"; they check
// that **nothing** landed outside the root, which is the property that matters.

let TMP: string;
let HOME_BEFORE: string[];

const HOME_TIRNO = path.join(os.homedir(), '.tirno');

function lsTree(dir: string, prefix = ''): string[] {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    out.push(e.isDirectory() ? rel + '/' : rel);
    if (e.isDirectory()) out.push(...lsTree(path.join(dir, e.name), rel));
  }
  return out;
}

before(() => {
  HOME_BEFORE = lsTree(HOME_TIRNO);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-paths-test-'));
  process.env.TIRNO_DIR = TMP;
});

after(() => {
  delete process.env.TIRNO_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('every store writes under TIRNO_DIR and nothing escapes to the real home', () => {
  const now = new Date().toISOString();
  refs.save('sess', { '1': 42 });
  trails.setActive({ name: 't', goal: 'goal', startUrl: 'about:blank', startedAt: now });
  trails.save({ name: 't', goal: 'goal', startUrl: 'about:blank', capturedAt: now, durationMs: 0, steps: [] });
  records.save({ name: 'r', startUrl: 'about:blank', capturedAt: now, durationMs: 0, events: [] });
  cache.save({
    schemaVersion: 1, url: 'https://example.com/x', urlPath: '/x', domain: 'example.com',
    capturedAt: now, visualFp: '0'.repeat(16),
    viewport: { w: 1920, h: 1080, dpr: 1 }, refs: [],
  });
  // writeScreenshot only cares that it is bytes — a PNG signature is enough.
  writeScreenshot(Buffer.from('89504e470d0a1a0a', 'hex'));

  const wrote = lsTree(TMP);
  for (const expected of ['refs/sess.json', 'trails/t.json', 'recordings/r.json', 'active-trail.json']) {
    assert.ok(wrote.includes(expected), `${expected} not under TIRNO_DIR: ${wrote.join(' ')}`);
  }
  assert.ok(wrote.some(p => p.startsWith('visual-cache/')), 'visual cache escaped the root');
  assert.ok(wrote.some(p => p.startsWith('tmp/') && p.endsWith('.png')), 'screenshot escaped the root');

  const escaped = lsTree(HOME_TIRNO).filter(p => !HOME_BEFORE.includes(p));
  assert.deepEqual(escaped, [], `wrote outside TIRNO_DIR: ${escaped.join(', ')}`);
});

test('a per-store override still wins over the root', () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-paths-override-'));
  process.env.TIRNO_RECORDINGS_DIR = elsewhere;
  try {
    records.save({ name: 'over', startUrl: 'about:blank', capturedAt: new Date().toISOString(), durationMs: 0, events: [] });
    assert.ok(fs.existsSync(path.join(elsewhere, 'over.json')));
    assert.ok(!fs.existsSync(path.join(TMP, 'recordings', 'over.json')));
  } finally {
    delete process.env.TIRNO_RECORDINGS_DIR;
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});
