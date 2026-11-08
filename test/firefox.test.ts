import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFirefox, firefoxArgs, parseFirefoxProfile, readFrames } from '../src/core/firefox.js';

const frame = (o: unknown): string => { const s = JSON.stringify(o); return `${Buffer.byteLength(s)}:${s}`; };

test('frames are split on the byte length, not the character count', () => {
  const { frames, rest } = readFrames(Buffer.from(frame({ a: '한글' }) + frame([1, 2])));
  assert.deepEqual(frames, [{ a: '한글' }, [1, 2]]);
  assert.equal(rest.length, 0);
});

test('a partial frame stays in the buffer until the rest arrives', () => {
  const whole = Buffer.from(frame({ a: 1 }));
  const first = readFrames(whole.subarray(0, 4));
  assert.deepEqual(first.frames, []);
  assert.deepEqual(readFrames(Buffer.concat([first.rest, whole.subarray(4)])).frames, [{ a: 1 }]);
});

test('the profile is read back from the command line, spaces included', () => {
  const cmd = firefoxArgs('/Users/a b/profile', true).join(' ');
  assert.equal(parseFirefoxProfile(`/Applications/Firefox.app/Contents/MacOS/firefox ${cmd}`), '/Users/a b/profile');
  assert.equal(parseFirefoxProfile('/usr/bin/chrome --user-data-dir=/x'), null);
});

const hasFirefox = (): boolean => { try { return !!findFirefox(); } catch { return false; } };

test('a firefox session starts on a scriptable page and stays firefox across restart', { skip: !hasFirefox() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-ff-'));
  const bin = path.join(import.meta.dirname, '..', '..', 'bin', 'tirno.js');
  const tirno = (...args: string[]) => execFileSync('node', [bin, ...args], { env: { ...process.env, TIRNO_DIR: dir }, encoding: 'utf8', stdio: 'pipe' });
  try {
    tirno('new', 'ff', '--browser', 'firefox', '--headless');
    assert.match(tirno('eval', '-s', 'ff', 'location.href'), /about:blank/);
    tirno('restart', 'ff', '--headless');
    assert.match(tirno('eval', '-s', 'ff', 'navigator.userAgent'), /Firefox/);
    assert.equal(JSON.parse(tirno('ls', '--json'))[0].engine, 'firefox');
  } finally {
    try { tirno('kill', 'ff'); } catch { /* new failed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a firefox session snapshots, clicks, fills and waits like a chrome one', { skip: !hasFirefox() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-ff-'));
  const bin = path.join(import.meta.dirname, '..', '..', 'bin', 'tirno.js');
  const tirno = (...args: string[]) => execFileSync('node', [bin, ...args, '-s', 'ffa'], { env: { ...process.env, TIRNO_DIR: dir }, encoding: 'utf8', stdio: 'pipe' });
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, `<!doctype html><title>t</title>
    <form onsubmit="event.preventDefault(); out.textContent = 'sent:' + q.value">
      <label for=q>Email</label><input id=q>
      <button type=button onclick="this.textContent = 'done'">Go</button>
      <div style="position:relative"><button type=button>Under</button><div style="position:absolute;inset:0;background:#fff">x</div></div>
    </form><p id=out></p><div id=re><button>Old</button></div>`);
  try {
    execFileSync('node', [bin, 'new', 'ffa', `file://${page}`, '--browser', 'firefox', '--headless'], { env: { ...process.env, TIRNO_DIR: dir }, stdio: 'pipe' });
    const snap = tirno('snapshot');
    assert.match(snap, /@\d+\s+textbox "Email"/);
    const go = /@(\d+)\s+button "Go"/.exec(snap)![1];
    tirno('click', `@${go}`);
    assert.equal(tirno('eval', 'document.querySelector("button").textContent').trim(), 'done');
    tirno('fill', 'textbox', 'Email', 'Ab!');
    tirno('press', 'Enter');
    assert.match(tirno('wait-for', '--text', 'sent:Ab!', '--timeout', '5000'), /Text visible/);
    assert.throws(() => tirno('click', 'button', 'Under'), /covered at/);
    const old = /@(\d+)\s+button "Old"/.exec(snap)![1];
    tirno('eval', 're.innerHTML = "<button>New</button>"');
    assert.throws(() => tirno('click', `@${old}`), /no longer in the document/);
    assert.throws(() => tirno('wait-for', '--network-idle'), /capability_unsupported/);
  } finally {
    try { execFileSync('node', [bin, 'kill', 'ffa'], { env: { ...process.env, TIRNO_DIR: dir }, stdio: 'pipe' }); } catch { /* new failed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
