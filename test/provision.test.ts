import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apparmorProfile, findBinary, plan, platformKey } from '../src/core/provision.js';

// 네트워크를 안 탄다 — 여기서 증명하는 것은 **어느 출처를 고르는가** 이고, 그것은
// 버전 피드의 모양만 있으면 재현된다. 실제 다운로드는 스모크가 본다.

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-prov-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const CFT_FEED = {
  channels: {
    Stable: {
      version: '152.0.7977.54',
      downloads: {
        chrome: [
          { platform: 'linux64', url: 'https://storage.googleapis.com/x/linux64/chrome-linux64.zip' },
          { platform: 'mac-arm64', url: 'https://storage.googleapis.com/x/mac-arm64/chrome-mac-arm64.zip' },
          { platform: 'mac-x64', url: 'https://storage.googleapis.com/x/mac-x64/chrome-mac-x64.zip' },
          { platform: 'win64', url: 'https://storage.googleapis.com/x/win64/chrome-win64.zip' },
        ],
      },
    },
  },
};

const feedFetch = (ok = true) => (async () => ({
  ok,
  status: ok ? 200 : 503,
  json: async () => CFT_FEED,
})) as unknown as typeof fetch;

test('tirno release targets all map to a platform key; others do not', () => {
  assert.equal(platformKey('linux', 'x64'), 'linux64');
  assert.equal(platformKey('linux', 'arm64'), 'linux-arm64');
  assert.equal(platformKey('darwin', 'arm64'), 'mac-arm64');
  assert.equal(platformKey('darwin', 'x64'), 'mac-x64');
  assert.equal(platformKey('win32', 'x64'), null, 'Windows is not a target — ownership reads lsof/ps');
  assert.equal(platformKey('linux', 'ppc64'), null);
});

// 구글은 리눅스용 Chrome 을 amd64 로만 배포하고, Chrome for Testing 의 플랫폼 목록에도
// arm64 리눅스가 없다(실측). Playwright 만 그 자리를 빌드한다 — 그래서 출처가 갈린다.
test('linux-arm64 comes from the Playwright CDN, and needs no version feed', async () => {
  const p = await plan('linux-arm64', (() => { throw new Error('must not fetch'); }) as unknown as typeof fetch);
  assert.equal(p.source, 'playwright');
  assert.match(p.url, /cdn\.playwright\.dev.*chromium-linux-arm64\.zip$/);
});

test('the other targets come from Chrome for Testing, at the Stable version', async () => {
  for (const key of ['linux64', 'mac-arm64', 'mac-x64']) {
    const p = await plan(key, feedFetch());
    assert.equal(p.source, 'chrome-for-testing', key);
    assert.ok(p.url.includes(key), `${key}: ${p.url}`);
    assert.equal(p.version, '152.0.7977.54');
    assert.equal(p.label, 'chrome-152.0.7977.54');
  }
});

// 피드가 그 플랫폼을 안 내면, 무엇은 내는지까지 말해야 사용자가 다음 수를 안다.
test('a platform the feed does not build is named along with what it does build', async () => {
  await assert.rejects(() => plan('linux-arm64-but-cft' as string, feedFetch()), /does not build.*linux64, mac-arm64/s);
});

test('a version feed that is down says so rather than guessing a URL', async () => {
  await assert.rejects(() => plan('linux64', feedFetch(false)), /version feed said 503/);
});

// ── 압축을 푼 뒤 실행 파일 찾기

function makeExecutable(rel: string): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\n');
  fs.chmodSync(p, 0o755);
  return p;
}

test('the expected layout is found by its candidate path', () => {
  const wanted = makeExecutable('chrome-linux/chrome');
  assert.equal(findBinary(tmp, ['chrome-linux/chrome', 'chrome-linux64/chrome']), wanted);
});

// 아카이브 구조는 배포처 사정으로 바뀐다. 후보가 빗나갔다고 포기하면, 그 실패는
// "받았는데 못 쓴다" 가 되어 프로비저닝의 값이 통째로 사라진다.
test('an unexpected layout is still found by walking the tree', () => {
  const wanted = makeExecutable('some/new/layout/chrome');
  assert.equal(findBinary(tmp, ['chrome-linux/chrome']), wanted);
});

test('a non-executable file of the right name is not the binary', () => {
  const p = path.join(tmp, 'chrome');
  fs.writeFileSync(p, 'not executable');
  fs.chmodSync(p, 0o644);
  assert.equal(findBinary(tmp, []), null);
});

test('nothing there means null, not a throw', () => {
  assert.equal(findBinary(path.join(tmp, 'missing'), ['a/b']), null);
});

// AppArmor 는 실행되는 그 파일의 경로로 프로파일을 붙인다. 링크를 적으면 아무 데도 안 걸린다.
test('the AppArmor snippet resolves symlinks to the real binary', () => {
  const real = makeExecutable('real/chrome');
  const link = path.join(tmp, 'link-to-chrome');
  fs.symlinkSync(real, link);
  const profile = apparmorProfile(link);
  assert.ok(profile.includes(fs.realpathSync(real)), profile);
  assert.ok(!profile.includes('link-to-chrome'), profile);
  assert.match(profile, /userns,/);
});
