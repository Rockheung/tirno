import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as store from '../src/core/session-store.js';
import * as anchors from '../src/core/anchor-store.js';
import { UnsafeName } from '../src/core/path-guard.js';

// Anchors are the directory a browser MCP is configured against, so the two
// things that must hold are: the symlink points where we say it does, and
// nothing here ever deletes a profile (that is a logged-in browser session).

let TMP: string;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-anchor-test-'));
  process.env.TIRNO_DIR = TMP;
});

after(() => {
  delete process.env.TIRNO_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  for (const e of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, e), { recursive: true, force: true });
});

function makeSession(name: string, over: Partial<store.SessionMetadata> = {}): store.SessionMetadata {
  const userDataDir = over.userDataDir ?? store.profileDir(name);
  fs.mkdirSync(userDataDir, { recursive: true });
  const meta: store.SessionMetadata = {
    name,
    pid: 1234,
    port: 50000,
    wsEndpoint: 'ws://127.0.0.1:50000/devtools/browser/abc',
    userDataDir,
    chromeFlags: ['--remote-debugging-port=0'],
    createdAt: '2026-08-14T00:00:00.000Z',
    lastAccessedAt: '2026-08-14T00:00:00.000Z',
    ...over,
  };
  store.create(meta);
  return meta;
}

test('set creates a relative symlink into profiles/', () => {
  makeSession('main');
  anchors.set('mcp', 'main');

  const linkPath = store.anchorPath('mcp');
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(linkPath), path.join('..', 'profiles', 'main'));

  const a = anchors.read('mcp');
  assert.equal(a?.session, 'main');
  assert.equal(a?.live, true);
  // lexical, not realpath'd — see Anchor.resolved
  assert.equal(a?.resolved, path.resolve(store.profileDir('main')));
});

test('the anchor directory is what a MCP would read — DevToolsActivePort resolves through it', () => {
  makeSession('main');
  anchors.set('mcp', 'main');
  fs.writeFileSync(path.join(store.profileDir('main'), 'DevToolsActivePort'), '50747\n/devtools/browser/x');

  assert.equal(
    fs.readFileSync(path.join(store.anchorPath('mcp'), 'DevToolsActivePort'), 'utf-8'),
    '50747\n/devtools/browser/x',
  );
});

test('an ephemeral profile outside profiles/ gets an absolute symlink', () => {
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-eph-'));
  try {
    makeSession('eph', { userDataDir: tmpProfile });
    anchors.set('mcp', 'eph');
    assert.equal(fs.readlinkSync(store.anchorPath('mcp')), tmpProfile);
    assert.equal(anchors.read('mcp')?.session, 'eph');
  } finally {
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  }
});

test('set reports the anchor it replaced so the caller can evict it', () => {
  makeSession('a');
  makeSession('b');
  assert.equal(anchors.set('mcp', 'a').previous, null);

  const { previous } = anchors.set('mcp', 'b');
  assert.equal(previous?.session, 'a');
  assert.equal(anchors.read('mcp')?.session, 'b');
});

test('set on a missing session throws and leaves no anchor behind', () => {
  assert.throws(() => anchors.set('mcp', 'nope'), /not found/);
  assert.equal(anchors.read('mcp'), null);
});

test('rm removes only the symlink — the profile survives', () => {
  makeSession('main');
  fs.writeFileSync(path.join(store.profileDir('main'), 'Cookies'), 'session-data');
  anchors.set('mcp', 'main');

  anchors.remove('mcp');

  assert.equal(anchors.read('mcp'), null);
  assert.equal(fs.existsSync(store.profileDir('main')), true);
  assert.equal(fs.readFileSync(path.join(store.profileDir('main'), 'Cookies'), 'utf-8'), 'session-data');
});

test('rm on an unknown anchor throws AnchorNotFound', () => {
  assert.throws(() => anchors.remove('nope'), /not found/);
});

// The dangerous case: `anchors/<name>` exists but is a real directory holding a
// profile. Replacing or removing it as if it were a link would delete data.
test('a real directory in anchors/ is never unlinked', () => {
  makeSession('main');
  const real = store.anchorPath('mcp');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'Cookies'), 'real-data');

  assert.throws(() => anchors.set('mcp', 'main'), /not a symlink/);
  assert.throws(() => anchors.remove('mcp'), /not a symlink/);
  assert.equal(fs.readFileSync(path.join(real, 'Cookies'), 'utf-8'), 'real-data');
});

test('anchor names must be single segments', () => {
  makeSession('main');
  for (const bad of ['../escape', 'a/b', '/abs', '..']) {
    assert.throws(() => anchors.set(bad, 'main'), (e: Error) => e instanceof UnsafeName);
  }
  assert.throws(() => anchors.remove('../escape'), (e: Error) => e instanceof UnsafeName);
});

test('a dangling anchor is reported, not thrown on', () => {
  makeSession('main');
  anchors.set('mcp', 'main');
  fs.rmSync(store.profileDir('main'), { recursive: true, force: true });

  const a = anchors.read('mcp');
  assert.equal(a?.live, false);
  assert.equal(a?.name, 'mcp');
  assert.equal(anchors.list().length, 1);
});

test('list returns anchors sorted, ignoring non-symlink entries', () => {
  makeSession('a');
  makeSession('b');
  anchors.set('zulu', 'a');
  anchors.set('alpha', 'b');
  fs.mkdirSync(path.join(store.anchorsRoot(), 'notalink'), { recursive: true });

  assert.deepEqual(anchors.list().map(a => a.name), ['alpha', 'zulu']);
});

test('list is empty when no anchors directory exists', () => {
  assert.deepEqual(anchors.list(), []);
});

test('anchorsForSession finds every anchor aimed at one profile', () => {
  makeSession('main');
  makeSession('other');
  anchors.set('one', 'main');
  anchors.set('two', 'main');
  anchors.set('three', 'other');

  assert.deepEqual(anchors.anchorsForSession('main').map(a => a.name), ['one', 'two']);
});

// anchors/* and `active` are deliberately separate: switching the CLI session
// must not re-aim an MCP at a different browser.
test('changing the active session does not move an anchor', () => {
  makeSession('a');
  makeSession('b');
  anchors.set('mcp', 'a');

  store.setActive('b');

  assert.equal(anchors.read('mcp')?.session, 'a');
  assert.equal(store.getActive(), 'b');
});
