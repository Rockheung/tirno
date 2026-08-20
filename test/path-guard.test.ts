import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeSegment, assertSafeSegment, isDirectChildOf, UnsafeName } from '../src/core/path-guard.js';

// plan-anchor-broker.md §4 T4 — names that reach the filesystem must be single
// segments. gc deletes profiles and anchor set replaces symlinks; a name that
// escapes ~/.tirno is the difference between removing a profile and removing
// someone's home directory.

test('accepts ordinary session/anchor names', () => {
  for (const name of ['main', 'wt-foo', 'legacy-widget-session', 'a.b', 'a b', '2026-05-10-admin', '한글']) {
    assert.equal(isSafeSegment(name), true, `should accept: ${name}`);
  }
});

test('rejects traversal, absolute paths and separators', () => {
  for (const name of [
    '',
    '.',
    '..',
    '../..',
    '../profiles/other',
    'a/b',
    '/etc',
    '/Users/me/.tirno/profiles/main',
    './main',
    'main/',
    'a\\b',
    'a\0b',
  ]) {
    assert.equal(isSafeSegment(name), false, `should reject: ${JSON.stringify(name)}`);
  }
});

test('assertSafeSegment throws UnsafeName naming what was rejected', () => {
  assert.throws(
    () => assertSafeSegment('../escape', 'anchor name'),
    (e: Error) => e instanceof UnsafeName && /anchor name/.test(e.message) && /\.\.\/escape/.test(e.message),
  );
});

test('isDirectChildOf accepts only immediate children', () => {
  const root = '/Users/me/.tirno/profiles';
  assert.equal(isDirectChildOf(root, '/Users/me/.tirno/profiles/main'), true);
  assert.equal(isDirectChildOf(root, '/Users/me/.tirno/profiles/main/Default'), false);
  assert.equal(isDirectChildOf(root, '/Users/me/.tirno/profiles'), false);
  assert.equal(isDirectChildOf(root, '/Users/me/.tirno'), false);
  assert.equal(isDirectChildOf(root, '/Users/me/.tirno/sessions/main'), false);
});

test('isDirectChildOf is not fooled by a traversal that lands back inside', () => {
  const root = '/Users/me/.tirno/profiles';
  // resolves to /Users/me/.tirno/profiles/main — genuinely a direct child
  assert.equal(isDirectChildOf(root, '/Users/me/.tirno/profiles/x/../main'), true);
  // resolves outside
  assert.equal(isDirectChildOf(root, '/Users/me/.tirno/profiles/../../secrets'), false);
});
