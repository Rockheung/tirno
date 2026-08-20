import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  activePortPath,
  parseActivePort,
  readActivePort,
  waitForActivePort,
  clearActivePort,
} from '../src/core/devtools-port.js';

// plan-anchor-broker.md T3 — DevToolsActivePort is an *observed* chrome
// behaviour, not a documented contract, and chrome-devtools-mcp parses the same
// file. If a chrome update changes the format, this is where it should break.

let TMP: string;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-devtools-port-test-'));
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(activePortPath(TMP), { force: true });
});

const write = (body: string): void => fs.writeFileSync(activePortPath(TMP), body);

// exactly what chrome 151 wrote during gate 1 (docs/plan-anchor-broker.md §7.1)
const REAL = '59524\n/devtools/browser/fd7be2ef-7a84-411e-b7bd-27f299394ff4';

test('parses the real chrome-151 file body', () => {
  const parsed = parseActivePort(REAL);
  assert.deepEqual(parsed, {
    port: 59524,
    wsPath: '/devtools/browser/fd7be2ef-7a84-411e-b7bd-27f299394ff4',
    wsEndpoint: 'ws://127.0.0.1:59524/devtools/browser/fd7be2ef-7a84-411e-b7bd-27f299394ff4',
  });
});

test('tolerates a trailing newline', () => {
  assert.equal(parseActivePort(`${REAL}\n`)?.port, 59524);
});

test('rejects malformed bodies instead of guessing', () => {
  for (const bad of [
    '',
    '59524',                               // port only, no ws path
    '\n/devtools/browser/abc',             // ws path only
    'notaport\n/devtools/browser/abc',
    '0\n/devtools/browser/abc',            // chrome never reports 0 once bound
    '70000\n/devtools/browser/abc',        // out of range
    '59524\ndevtools/browser/abc',         // path must be absolute
  ]) {
    assert.equal(parseActivePort(bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('readActivePort returns null when the file is absent', () => {
  assert.equal(readActivePort(TMP), null);
  assert.equal(readActivePort(path.join(TMP, 'no-such-profile')), null);
});

test('readActivePort reads a written file', () => {
  write(REAL);
  assert.equal(readActivePort(TMP)?.port, 59524);
});

test('clearActivePort removes the file and is safe to repeat', () => {
  write(REAL);
  clearActivePort(TMP);
  assert.equal(fs.existsSync(activePortPath(TMP)), false);
  clearActivePort(TMP);                    // absent already
  clearActivePort(path.join(TMP, 'gone')); // dir does not exist
});

test('waitForActivePort returns null on timeout rather than hanging', async () => {
  const started = Date.now();
  assert.equal(await waitForActivePort(TMP, 300), null);
  assert.ok(Date.now() - started >= 300);
});

test('waitForActivePort picks the file up once it appears', async () => {
  const timer = setTimeout(() => write(REAL), 150);
  try {
    assert.equal((await waitForActivePort(TMP, 5000))?.port, 59524);
  } finally {
    clearTimeout(timer);
  }
});
