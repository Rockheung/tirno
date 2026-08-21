import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetNameFor, compareVersions, parseChecksums, selfReplaceTarget } from '../src/core/update.js';

// 문자열 비교로는 0.2.10 이 0.2.9 보다 낮다고 나오고, 그러면 밀린 상태에서
// "최신입니다" 를 말하게 된다 — 틀린 답이 조용히 나가는 자리다.
test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('0.2.9', '0.2.10'), -1);
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('v0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('0.3.0', '0.2.99'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('compareVersions ignores a prerelease suffix', () => {
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0'), 0);
});

test('assetNameFor matches the release matrix', () => {
  assert.equal(assetNameFor('darwin', 'arm64'), 'tirno-bun-darwin-arm64');
  assert.equal(assetNameFor('darwin', 'x64'), 'tirno-bun-darwin-x64');
  assert.equal(assetNameFor('linux', 'arm64'), 'tirno-bun-linux-arm64');
  assert.equal(assetNameFor('linux', 'x64'), 'tirno-bun-linux-x64');
});

test('assetNameFor refuses a platform the release does not build', () => {
  assert.throws(() => assetNameFor('win32', 'x64'), /No release binary/);
  assert.throws(() => assetNameFor('linux', 'ia32'), /No release binary/);
});

// 실제 v0.2.1 릴리즈가 낸 형식 그대로.
test('parseChecksums reads sha256sum output', () => {
  const text = [
    'a51c25fdf6d083bbc9fb6220582ff266fdde4ac2cab23ce03b8f2fef1a44ed5f  tirno-bun-darwin-arm64',
    'f0c51aa71ebaa34298889447f1bcf374cb8d6689983c3e04b203cda1dcda34d6  tirno-bun-darwin-x64',
    '',
  ].join('\n');
  const m = parseChecksums(text);
  assert.equal(m.size, 2);
  assert.equal(m.get('tirno-bun-darwin-arm64'), 'a51c25fdf6d083bbc9fb6220582ff266fdde4ac2cab23ce03b8f2fef1a44ed5f');
});

test('parseChecksums ignores lines that are not checksums', () => {
  assert.equal(parseChecksums('garbage\nsha256: nope\n').size, 0);
  // 짧은 해시는 sha256 이 아니다 — 받아들이면 검증이 통과해 버린다.
  assert.equal(parseChecksums('abc123  tirno-bun-linux-x64').size, 0);
});

// execPath 를 잘못 짚으면 런타임을 덮어쓴다. bun 으로 컴파일한 것만 대상이다.
test('selfReplaceTarget only accepts a compiled single-file binary', () => {
  assert.equal(selfReplaceTarget('/usr/local/bin/tirno', '1.2.3'), '/usr/local/bin/tirno');
  assert.equal(selfReplaceTarget('/usr/local/bin/bun', '1.2.3'), null);   // bun run
  assert.equal(selfReplaceTarget('/usr/local/bin/node', undefined), null); // node bin/tirno.js
});
