import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { intArg, floatArg, stripTrailingNewline } from '../src/util/parsers.js';

test('intArg parses base-10 ignoring extra args', () => {
  // commander passes (value, prev) — wrapper must not let prev become radix
  assert.equal((intArg as (v: string, p?: number) => number)('70', 50), 70);
  assert.equal(intArg('123'), 123);
});

test('floatArg parses float ignoring extra args', () => {
  assert.equal((floatArg as (v: string, p?: number) => number)('1.5', 0.3), 1.5);
  assert.equal(floatArg('2.71'), 2.71);
});

test('regression: bare parseInt as commander coercer fails (this is why we wrap)', () => {
  // sanity check showing the original bug — parseInt('70', 50) → NaN
  assert.ok(Number.isNaN(parseInt('70', 50)));
  // and intArg fixes it
  assert.equal(intArg('70'), 70);
});

test('intArg wired through commander does not return NaN with default', () => {
  const p = new Command();
  let captured: number | undefined;
  p.command('test')
    .option('--n <n>', 'desc', intArg, 50)
    .action((opts) => { captured = opts.n; });
  p.parse(['node', 'x', 'test', '--n', '70']);
  assert.equal(captured, 70);
});

test('floatArg wired through commander', () => {
  const p = new Command();
  let captured: number | undefined;
  p.command('test')
    .option('--x <n>', 'desc', floatArg, 0.3)
    .action((opts) => { captured = opts.x; });
  p.parse(['node', 'x', 'test', '--x', '0.85']);
  assert.equal(captured, 0.85);
});

test('stripTrailingNewline drops exactly one trailing newline', () => {
  assert.equal(stripTrailingNewline('pw\n'), 'pw');
  assert.equal(stripTrailingNewline('pw\r\n'), 'pw');
  assert.equal(stripTrailingNewline('pw'), 'pw');
  // 값 안의 개행은 값이다 — 마지막 하나만 뗀다.
  assert.equal(stripTrailingNewline('a\nb\n'), 'a\nb');
  assert.equal(stripTrailingNewline('pw\n\n'), 'pw\n');
  assert.equal(stripTrailingNewline(''), '');
  assert.equal(stripTrailingNewline('\n'), '');
});
