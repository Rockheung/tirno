import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionalUrl } from '../src/commands/session.js';

// Everything after `--` belongs to chrome, but commander passes those args to
// the action as operands too, so the first chrome flag also arrives as [url].

function argv(...rest: string[]): string[] {
  return ['/usr/bin/node', '/x/bin/tirno.js', ...rest];
}

test('a url before the separator is the real positional', () => {
  const a = argv('new', 'work', 'https://example.com', '--', '--no-proxy-server');
  assert.equal(positionalUrl(a, a.indexOf('--'), 'https://example.com'), 'https://example.com');
});

test('the first chrome flag is not a url', () => {
  const a = argv('new', 'work', '--headless', '--', '--no-proxy-server');
  assert.equal(positionalUrl(a, a.indexOf('--'), '--no-proxy-server'), undefined);
});

test('a url after the separator belongs to chrome, not to [url]', () => {
  const a = argv('new', 'work', '--', '--no-proxy-server', 'https://example.com');
  assert.equal(positionalUrl(a, a.indexOf('--'), '--no-proxy-server'), undefined);
});

test('no separator at all — the positional stands', () => {
  const a = argv('new', 'work', 'https://example.com');
  assert.equal(positionalUrl(a, -1, 'https://example.com'), 'https://example.com');
});

test('no positional given', () => {
  const a = argv('new', 'work', '--', '--no-proxy-server');
  assert.equal(positionalUrl(a, a.indexOf('--'), undefined), undefined);
});
