import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as store from '../src/core/session-store.js';
import * as gc from '../src/core/gc.js';
import type { SessionInventory } from '../src/core/inventory.js';

// gc deletes things, so the rules live in a pure plan() that can be asserted
// without a filesystem, and the deletion guards get their own sandbox.
// docs/plan-anchor-broker.md §3 Stage 4.

const NOW = new Date('2026-08-14T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

const inv = (over: Partial<SessionInventory> = {}): SessionInventory => ({
  name: 's',
  pid: 1,
  resolvedPort: 9222,
  listeners: [],
  wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/x',
  ownership: 'ours',
  reason: 'because',
  ...over,
});

const emptyScan = (over: Partial<gc.GcScan> = {}): gc.GcScan => ({
  sessions: [],
  activeSession: null,
  anchoredSessions: new Map(),
  orphans: [],
  stalePortFiles: [],
  ...over,
});

// ------------------------------------------------------------ plan: entries

test('a live owned session is left completely alone', () => {
  const p = gc.plan(emptyScan({ sessions: [inv({ name: 'live', ownership: 'ours' })] }), {}, NOW);
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.skipped, []);
});

test('a ghost entry is removed', () => {
  const p = gc.plan(emptyScan({ sessions: [inv({ name: 'gone', ownership: 'ghost' })] }), {}, NOW);
  assert.deepEqual(p.actions.map(a => [a.kind, a.target]), [['session-entry', 'gone']]);
});

test('a foreign entry is removed, but only the entry', () => {
  const p = gc.plan(emptyScan({
    sessions: [inv({ name: 'squatted', ownership: 'foreign', reason: 'port 9222 now belongs to OtherAgentApp (pid 1285)' })],
  }), {}, NOW);

  assert.equal(p.actions.length, 1);
  assert.equal(p.actions[0].kind, 'session-entry');
  assert.match(p.actions[0].reason, /OtherAgentApp/);
  assert.match(p.actions[0].reason, /process and profile untouched/);
  // nothing that would remove a directory or kill anything
  assert.equal(p.actions.some(a => a.kind === 'profile-dir'), false);
});

test('an ambiguous session is reported and never acted on', () => {
  const p = gc.plan(emptyScan({ sessions: [inv({ name: 'two', ownership: 'ambiguous' })] }), {}, NOW);
  assert.deepEqual(p.actions, []);
  assert.match(p.skipped[0].reason, /No automatic action/);
});

test('an anchored session entry is kept even when stale', () => {
  const p = gc.plan(emptyScan({
    sessions: [inv({ name: 'gone', ownership: 'ghost' })],
    anchoredSessions: new Map([['gone', ['main', 'wt-foo']]]),
  }), {}, NOW);
  assert.deepEqual(p.actions, []);
  assert.match(p.skipped[0].reason, /anchored by main, wt-foo/);
});

test('the active session entry is kept even when stale', () => {
  const p = gc.plan(emptyScan({
    sessions: [inv({ name: 'gone', ownership: 'ghost' })],
    activeSession: 'gone',
  }), {}, NOW);
  assert.deepEqual(p.actions, []);
  assert.match(p.skipped[0].reason, /active session/);
});

// -------------------------------------------------------- plan: port files

test('a stale DevToolsActivePort is removed', () => {
  const p = gc.plan(emptyScan({
    stalePortFiles: [{ profileDir: '/x/profiles/a', file: '/x/profiles/a/DevToolsActivePort', port: 50747 }],
  }), {}, NOW);
  assert.deepEqual(p.actions.map(a => [a.kind, a.path]), [['stale-port-file', '/x/profiles/a/DevToolsActivePort']]);
});

// ----------------------------------------------------------- plan: profiles

const orphan = (over: Partial<gc.OrphanProfile> = {}): gc.OrphanProfile => ({
  name: 'old',
  dir: '/x/profiles/old',
  mtime: daysAgo(90),
  sizeKb: 2048,
  anchoredBy: [],
  ...over,
});

test('orphan profiles are only listed without --older-than', () => {
  const p = gc.plan(emptyScan({ orphans: [orphan()] }), {}, NOW);
  assert.deepEqual(p.actions, []);
  assert.match(p.skipped[0].reason, /--older-than/);
});

test('--older-than removes orphans past the age, with size and last-used', () => {
  const p = gc.plan(emptyScan({ orphans: [orphan()] }), { olderThanDays: 30 }, NOW);
  assert.equal(p.actions.length, 1);
  assert.equal(p.actions[0].kind, 'profile-dir');
  assert.equal(p.actions[0].sizeKb, 2048);
  assert.equal(p.actions[0].lastUsed, '2026-05-16 12:00:00');
});

test('--older-than keeps orphans younger than the cutoff', () => {
  const p = gc.plan(emptyScan({ orphans: [orphan({ mtime: daysAgo(5) })] }), { olderThanDays: 30 }, NOW);
  assert.deepEqual(p.actions, []);
  assert.match(p.skipped[0].reason, /5\.0d ago/);
});

test('an anchored orphan is never deleted, however old', () => {
  const p = gc.plan(
    emptyScan({ orphans: [orphan({ mtime: daysAgo(9999), anchoredBy: ['main'] })] }),
    { olderThanDays: 1 },
    NOW,
  );
  assert.deepEqual(p.actions, []);
  assert.match(p.skipped[0].reason, /anchored by main/);
});

// -------------------------------------------------------- deletion guards

let TMP: string;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-gc-test-'));
  process.env.TIRNO_DIR = TMP;
});

after(() => {
  delete process.env.TIRNO_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  for (const e of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, e), { recursive: true, force: true });
  fs.mkdirSync(store.profilesRoot(), { recursive: true });
});

test('assertDeletable accepts a real profile directory', () => {
  const dir = store.profileDir('ok');
  fs.mkdirSync(dir, { recursive: true });
  assert.doesNotThrow(() => gc.assertDeletable(dir));
});

test('assertDeletable rejects anything that is not a direct child of profiles/', () => {
  const nested = path.join(store.profileDir('ok'), 'Default');
  fs.mkdirSync(nested, { recursive: true });
  assert.throws(() => gc.assertDeletable(nested), /not directly inside/);
  assert.throws(() => gc.assertDeletable(store.profilesRoot()), /not directly inside/);
  assert.throws(() => gc.assertDeletable(path.join(TMP, 'sessions')), /not directly inside/);
  assert.throws(() => gc.assertDeletable(os.homedir()), /not directly inside/);
});

test('assertDeletable rejects a symlinked profile so the target survives', () => {
  const real = path.join(TMP, 'somewhere-else');
  fs.mkdirSync(real, { recursive: true });
  const link = store.profileDir('linked');
  fs.symlinkSync(real, link);

  assert.throws(() => gc.assertDeletable(link), /symlink/);
  assert.equal(fs.existsSync(real), true);
});

test('dry run reports actions but changes nothing on disk', () => {
  const dir = store.profileDir('old');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cookies'), 'session-data');

  const p: gc.GcPlan = { actions: [{ kind: 'profile-dir', target: 'old', path: dir, reason: 'orphan' }], skipped: [] };
  const result = gc.apply(p, true);

  assert.equal(result.applied.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'Cookies')), true);
});

test('apply deletes an orphan profile for real', () => {
  const dir = store.profileDir('old');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cookies'), 'session-data');

  const p: gc.GcPlan = { actions: [{ kind: 'profile-dir', target: 'old', path: dir, reason: 'orphan' }], skipped: [] };
  const result = gc.apply(p, false);

  assert.equal(result.failed.length, 0);
  assert.equal(fs.existsSync(dir), false);
});

test('a guard violation fails that action and leaves the target intact', () => {
  const outside = path.join(TMP, 'not-a-profile');
  fs.mkdirSync(outside, { recursive: true });

  const p: gc.GcPlan = { actions: [{ kind: 'profile-dir', target: 'evil', path: outside, reason: 'x' }], skipped: [] };
  const result = gc.apply(p, false);

  assert.equal(result.applied.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /not directly inside/);
  assert.equal(fs.existsSync(outside), true);
});

test('one failing action does not stop the rest', () => {
  const good = store.profileDir('good');
  fs.mkdirSync(good, { recursive: true });
  const outside = path.join(TMP, 'outside');
  fs.mkdirSync(outside, { recursive: true });

  const result = gc.apply({
    actions: [
      { kind: 'profile-dir', target: 'evil', path: outside, reason: 'x' },
      { kind: 'profile-dir', target: 'good', path: good, reason: 'orphan' },
    ],
    skipped: [],
  }, false);

  assert.equal(result.failed.length, 1);
  assert.equal(result.applied.length, 1);
  assert.equal(fs.existsSync(good), false);
  assert.equal(fs.existsSync(outside), true);
});

test('scan finds an unclaimed profile dir as an orphan and leaves claimed ones alone', async () => {
  fs.mkdirSync(store.profileDir('claimed'), { recursive: true });
  fs.mkdirSync(store.profileDir('orphaned'), { recursive: true });
  store.create({
    name: 'claimed',
    pid: 999999,
    port: 65001,
    wsEndpoint: 'ws://127.0.0.1:65001/devtools/browser/x',
    userDataDir: store.profileDir('claimed'),
    chromeFlags: [],
    createdAt: NOW.toISOString(),
    lastAccessedAt: NOW.toISOString(),
  });

  const scanned = await gc.scan();
  assert.deepEqual(scanned.orphans.map(o => o.name), ['orphaned']);
  // pid 999999 is above the OS maximum, so the claimed session reads as a ghost
  // rather than accidentally matching a live process
  assert.equal(scanned.sessions.find(s => s.name === 'claimed')?.ownership, 'ghost');
});
