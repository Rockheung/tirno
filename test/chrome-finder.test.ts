import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chromeCandidates,
  clearConfiguredChrome,
  expandGlob,
  inspectCandidates,
  isRunnable,
  readConfig,
  resolveChrome,
  setConfiguredChrome,
} from '../src/core/chrome-finder.js';

// Chrome 은 안 띄운다. 여기서 증명하는 것은 **어느 경로를 어떤 순서로 고르는가** 이고,
// 그것은 파일시스템 + 환경변수만으로 전부 재현된다 — 가짜 실행파일이면 충분하다.

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV = ['TIRNO_DIR', 'TIRNO_CHROME', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH'];

function fakeChrome(name: string): string {
  const p = path.join(tmp, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-chrome-'));
  process.env['TIRNO_DIR'] = path.join(tmp, 'root');
  for (const k of ENV.slice(1)) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('--executable-path wins over everything', () => {
  const flag = fakeChrome('flag/chrome');
  process.env['TIRNO_CHROME'] = fakeChrome('env/chrome');
  setConfiguredChrome(fakeChrome('cfg/chrome'));
  const r = resolveChrome(flag);
  assert.equal(r.path, flag);
  assert.deepEqual(r.source, { kind: 'flag' });
});

test('env beats the saved config', () => {
  const env = fakeChrome('env/chrome');
  process.env['TIRNO_CHROME'] = env;
  setConfiguredChrome(fakeChrome('cfg/chrome'));
  const r = resolveChrome();
  assert.equal(r.path, env);
  assert.deepEqual(r.source, { kind: 'env', name: 'TIRNO_CHROME' });
});

test('env order: TIRNO_CHROME, then CHROME_PATH, then PUPPETEER_EXECUTABLE_PATH', () => {
  const chromePath = fakeChrome('a/chrome');
  const puppeteer = fakeChrome('b/chrome');
  process.env['CHROME_PATH'] = chromePath;
  process.env['PUPPETEER_EXECUTABLE_PATH'] = puppeteer;
  assert.equal(resolveChrome().path, chromePath);
  delete process.env['CHROME_PATH'];
  assert.equal(resolveChrome().path, puppeteer);
});

// 명시적으로 가리킨 경로가 틀렸을 때 조용히 다른 chrome 으로 넘어가면, 사용자는
// 자기가 지정한 바이너리가 돌고 있다고 믿은 채 다른 것을 관측하게 된다.
test('a broken env pointer is an error, not a silent fallback', () => {
  process.env['TIRNO_CHROME'] = path.join(tmp, 'does-not-exist');
  assert.throws(() => resolveChrome(), /TIRNO_CHROME is not an executable file/);
});

test('a non-executable file is not a chrome', () => {
  const p = path.join(tmp, 'plain');
  fs.writeFileSync(p, 'x');
  assert.equal(isRunnable(p), false);
  assert.equal(isRunnable(tmp), false, 'a directory is not runnable either');
});

test('config round-trips and can be cleared', () => {
  const p = fakeChrome('cfg/chrome');
  setConfiguredChrome(p);
  assert.equal(readConfig().chromePath, p);
  assert.deepEqual(resolveChrome().source, { kind: 'config' });
  assert.equal(clearConfiguredChrome(), true);
  assert.equal(readConfig().chromePath, undefined);
  assert.equal(clearConfiguredChrome(), false, 'clearing twice is not an error');
});

test('config set refuses a path that is not executable', () => {
  assert.throws(() => setConfiguredChrome(path.join(tmp, 'nope')), /Not an executable file/);
});

test('a configured binary that vanished says so instead of falling through', () => {
  const p = fakeChrome('cfg/chrome');
  setConfiguredChrome(p);
  fs.rmSync(p);
  assert.throws(() => resolveChrome(), /Configured chrome is gone/);
});

// #133 의 핵심: linux-arm64 에는 Google Chrome 이 없고, 실제로 존재하는 것은
// playwright 가 받아둔 빌드다. 그 경로가 후보에 있어야 sudo 심링크가 필요 없어진다.
test('linux candidates cover chromium, snap, and the playwright/puppeteer caches', () => {
  const linux = chromeCandidates('linux', '/home/u');
  assert.ok(linux.includes('/usr/bin/chromium'), 'Debian/Fedora package name');
  assert.ok(linux.includes('/snap/bin/chromium'), 'Ubuntu 24.04 ships chromium as a snap');
  assert.ok(linux.some(p => p.startsWith('/home/u/.cache/ms-playwright/chromium-')));
  assert.ok(linux.some(p => p.startsWith('/home/u/.cache/puppeteer/chrome/')));
});

test('expandGlob matches one segment at a time, newest version first', () => {
  fakeChrome('.cache/ms-playwright/chromium-999/chrome-linux/chrome');
  fakeChrome('.cache/ms-playwright/chromium-1234/chrome-linux/chrome');
  const hits = expandGlob(path.join(tmp, '.cache/ms-playwright/chromium-*/chrome-linux*/chrome'));
  assert.equal(hits.length, 2);
  assert.match(hits[0]!, /chromium-1234/, '1234 sorts before 999 numerically, not lexically');
});

test('expandGlob returns nothing rather than a half-resolved path', () => {
  assert.deepEqual(expandGlob(path.join(tmp, 'nowhere-*/chrome')), []);
});

test('inspectCandidates reports every source, including the unset ones', () => {
  const rows = inspectCandidates();
  const sources = rows.map(r => r.source);
  for (const name of ['$TIRNO_CHROME', '$CHROME_PATH', '$PUPPETEER_EXECUTABLE_PATH', 'config']) {
    assert.ok(sources.includes(name), `${name} must be listed even when unset`);
  }
  assert.ok(rows.filter(r => r.source === 'search').length > 0);
});
