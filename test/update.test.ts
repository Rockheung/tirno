import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetNameFor, compareVersions, installedPluginFrom, installedPluginsPath, parseChecksums, selfReplaceTarget } from '../src/core/update.js';

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

// 바이너리와 플러그인은 따로 낡는다. 이 값을 못 읽으면 플러그인이 0.2.0 인 채로
// "최신입니다" 가 나간다 — 이 명령이 묶으려던 바로 그 갈래가 조용히 빠진다.
test('installedPluginFrom reads id, marketplace and version together', () => {
  const raw = JSON.stringify({
    version: 2,
    plugins: {
      'other@mkt': [{ scope: 'user', version: 'cedd013e118f' }],
      'tirno@tirno': [{ scope: 'user', version: '0.2.0', installPath: '/x' }],
    },
  });
  assert.deepEqual(installedPluginFrom(raw), { id: 'tirno@tirno', marketplace: 'tirno', version: '0.2.0' });
});

// 마켓플레이스 이름은 marketplace.json 이 정하므로 fork 하면 달라진다. 그때도
// 버전을 읽는 쪽과 갱신을 부르는 쪽이 같은 식별자를 써야 한다.
test('installedPluginFrom follows a renamed marketplace', () => {
  const raw = JSON.stringify({ plugins: { 'tirno@my-fork': [{ version: '0.2.1' }] } });
  assert.deepEqual(installedPluginFrom(raw), { id: 'tirno@my-fork', marketplace: 'my-fork', version: '0.2.1' });
});

// scope 마다 항목이 하나씩 들어간다. 하나라도 낡았으면 갱신할 것이 있다.
test('installedPluginFrom takes the lowest version across scopes', () => {
  const raw = JSON.stringify({
    plugins: { 'tirno@tirno': [{ version: '0.2.2' }, { version: '0.2.0' }] },
  });
  assert.equal(installedPluginFrom(raw)?.version, '0.2.0');
});

test('installedPluginFrom returns null when there is nothing usable', () => {
  assert.equal(installedPluginFrom('not json'), null);
  assert.equal(installedPluginFrom('{}'), null);
  assert.equal(installedPluginFrom(JSON.stringify({ plugins: {} })), null);
  assert.equal(installedPluginFrom(JSON.stringify({ plugins: { 'tirno@tirno': [] } })), null);
  // 커밋 sha 로 설치된 것은 버전 비교가 안 된다 — 없는 것으로 본다.
  assert.equal(installedPluginFrom(JSON.stringify({
    plugins: { 'tirno@tirno': [{ version: 'cedd013e118f' }] },
  })), null);
  // 이름이 접두사로만 겹치는 것은 다른 플러그인이다.
  assert.equal(installedPluginFrom(JSON.stringify({
    plugins: { 'tirno-extra@mkt': [{ version: '1.0.0' }] },
  })), null);
});

test('installedPluginsPath honours CLAUDE_CONFIG_DIR', () => {
  assert.equal(installedPluginsPath('/home/u'), '/home/u/.claude/plugins/installed_plugins.json');
  assert.equal(installedPluginsPath('/home/u', '/cfg'), '/cfg/plugins/installed_plugins.json');
});
