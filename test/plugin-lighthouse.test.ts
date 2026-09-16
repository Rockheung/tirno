import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateLighthouse, pluginRoot } from '../src/core/plugin-lighthouse.js';

// lighthouse 는 번들에 없다 (#216). 여기서 잠그는 것은 찾는 순서 — 명시한 경로가 틀리면
// 다음 후보로 넘어가지 않는다(chrome-finder 와 같은 규칙), 플러그인 디렉터리가 전역보다 먼저.

let tmp: string; let saved: string | undefined;
beforeEach(() => { saved = process.env['TIRNO_DIR']; tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-lh-')); process.env['TIRNO_DIR'] = tmp; });
afterEach(() => { if (saved === undefined) delete process.env['TIRNO_DIR']; else process.env['TIRNO_DIR'] = saved; fs.rmSync(tmp, { recursive: true, force: true }); });

function fakeLighthouse(root: string, main = 'core/index.js'): string {
  const dir = path.join(root, 'node_modules', 'lighthouse');
  fs.mkdirSync(path.join(dir, path.dirname(main)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'lighthouse', main }));
  fs.writeFileSync(path.join(dir, main), 'export default 1');
  return path.join(dir, main);
}

test('TIRNO_LIGHTHOUSE — 파일이든 디렉터리든, 틀리면 null (다음 후보로 안 간다)', () => {
  const entry = fakeLighthouse(path.join(tmp, 'x'));
  assert.deepEqual(locateLighthouse({ TIRNO_LIGHTHOUSE: entry }), { entry, source: 'env' });
  assert.deepEqual(locateLighthouse({ TIRNO_LIGHTHOUSE: path.join(tmp, 'x') }), { entry, source: 'env' });
  fakeLighthouse(pluginRoot());
  assert.equal(locateLighthouse({ TIRNO_LIGHTHOUSE: '/nope' }), null, '플러그인이 있어도 명시한 경로가 틀리면 null');
});

test('플러그인 디렉터리가 있으면 그것 — 전역·레포보다 먼저', () => {
  const entry = fakeLighthouse(pluginRoot());
  assert.deepEqual(locateLighthouse({}), { entry, source: 'plugin' });
});

test('package.json 의 exports["."] 를 존중한다', () => {
  const dir = path.join(pluginRoot(), 'node_modules', 'lighthouse');
  fs.mkdirSync(path.join(dir, 'esm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'lighthouse', main: 'core/index.js', exports: { '.': { import: './esm/index.js' } } }));
  fs.writeFileSync(path.join(dir, 'esm', 'index.js'), '');
  assert.equal(locateLighthouse({})!.entry, path.join(dir, 'esm/index.js'));
});
