import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSafariDriverFor } from '../src/core/safari.js';

test('a safaridriver is ours only on the session port', () => {
  const stp = '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver';
  assert.equal(isSafariDriverFor(`${stp} -p 61797`, 61797), true);
  assert.equal(isSafariDriverFor(`${stp} -p 617970`, 61797), false);
  assert.equal(isSafariDriverFor('/usr/bin/safaridriver -p 61797', 61797), true);
  assert.equal(isSafariDriverFor('/usr/bin/chrome --remote-debugging-port=61797', 61797), false);
});

// 자동화 창이 뜨고 safaridriver 는 세션을 하나만 연다 — 원할 때만 돈다
test('a safari session clicks, fills and presses through safaridriver', { skip: process.env['TIRNO_TEST_SAFARI'] !== '1' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-sf-'));
  const bin = path.join(import.meta.dirname, '..', '..', 'bin', 'tirno.js');
  const env = { ...process.env, TIRNO_DIR: dir };
  const tirno = (...args: string[]) => execFileSync('node', [bin, ...args, '-s', 'sf'], { env, encoding: 'utf8', stdio: 'pipe' });
  // Safari 는 임시 디렉터리의 file:// 를 못 읽는다 — HTTP 로 준다. execFileSync 가 이 프로세스를
  // 막으므로 서버는 따로 띄운다
  const page = `<!doctype html><title>t</title>
    <form onsubmit="event.preventDefault(); out.textContent = 'sent:' + q.value">
      <label for=q>Email</label><input id=q>
      <button type=button onclick="this.textContent = 'done'">Go</button>
    </form><p id=out></p>`;
  const server = spawn(process.execPath, ['-e', `require('http').createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(${JSON.stringify(page)}); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); })`]);
  const port = await new Promise<string>(r => server.stdout.once('data', d => r(String(d).trim())));
  const url = `http://127.0.0.1:${port}/`;
  try {
    execFileSync('node', [bin, 'new', 'sf', url, '--browser', 'safari'], { env, stdio: 'pipe' });
    tirno('click', 'button', 'Go');
    assert.equal(tirno('eval', 'document.querySelector("button").textContent').trim(), 'done');
    tirno('fill', 'textbox', 'Email', 'Ab!');
    tirno('press', 'Enter');
    assert.match(tirno('wait-for', '--text', 'sent:Ab!', '--timeout', '5000'), /Text visible/);
    assert.equal(JSON.parse(execFileSync('node', [bin, 'ls', '--json'], { env, encoding: 'utf8' }))[0].ownership, 'ours');
  } finally {
    try { execFileSync('node', [bin, 'kill', 'sf', '--clean'], { env, stdio: 'pipe' }); } catch { /* new failed */ }
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
