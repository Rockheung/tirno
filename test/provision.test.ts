import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apparmorProfile, chromeRoot, findBinary, install, plan, platformKey } from '../src/core/provision.js';
import { readConfig } from '../src/core/chrome-finder.js';
import { makeZip, member } from './helpers/zip.js';

// 네트워크를 안 탄다 — 여기서 증명하는 것은 **어느 출처를 고르는가** 이고, 그것은
// 버전 피드의 모양만 있으면 재현된다. 실제 다운로드는 스모크가 본다.

let tmp: string;
let savedDir: string | undefined;
beforeEach(() => {
  savedDir = process.env['TIRNO_DIR'];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-prov-'));
  process.env['TIRNO_DIR'] = path.join(tmp, 'root');
});
afterEach(() => {
  if (savedDir === undefined) delete process.env['TIRNO_DIR'];
  else process.env['TIRNO_DIR'] = savedDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

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

// ── 받아서 푸는 전 과정. 네트워크는 안 탄다 — 실제 CDN 을 때리는 것은 게이트가 할 일이
// 아니고, 여기서 증명할 것은 **받은 바이트가 실행 가능한 브라우저가 되는가** 다.

function zipFetch(zipPath: string, over: Partial<Response> = {}): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-length': String(fs.statSync(zipPath).size) }),
    body: new Response(new Uint8Array(fs.readFileSync(zipPath))).body,
    ...over,
  })) as unknown as typeof fetch;
}

const planFor = (label: string, candidates: string[]) => ({
  source: 'playwright' as const,
  url: 'https://example.invalid/chromium.zip',
  label,
  version: '151.0.0.0',
  binaryCandidates: candidates,
});

test('install extracts the archive and finds the executable', async () => {
  const zip = makeZip(tmp, [
    member('chrome-linux/chrome', '#!/bin/sh\nexit 0\n', 0o100755),
    member('chrome-linux/icudtl.dat', 'data', 0o100644),
  ]);
  const result = await install(planFor('chromium-1234', ['chrome-linux/chrome']), {}, zipFetch(zip));

  assert.equal(result.binary, path.join(chromeRoot(), 'chromium-1234', 'chrome-linux', 'chrome'));
  assert.equal(result.files, 2);
  // 실행 비트를 잃으면 받아온 chrome 이 안 돈다 — 그러면 이 기능 전체가 무의미하다.
  assert.equal(fs.statSync(result.binary).mode & 0o111, 0o111);
});

test('progress is reported against the declared total', async () => {
  const zip = makeZip(tmp, [member('chrome-linux/chrome', 'x'.repeat(100), 0o100755)]);
  const seen: Array<[number, number]> = [];
  const result = await install(
    planFor('chromium-1234', ['chrome-linux/chrome']),
    { onProgress: (received, total) => seen.push([received, total]) },
    zipFetch(zip),
  );
  assert.ok(seen.length > 0, 'a 200MB download with no progress output is a hang, as far as the user can tell');
  assert.equal(seen.at(-1)![0], result.bytes);
  assert.equal(seen.at(-1)![1], fs.statSync(zip).size);
});

// 받았는데 못 쓰는 상태로 설정에 적으면, 다음 `new` 가 실패하고 그 실패는
// 프로비저닝이 아니라 tirno 의 버그처럼 읽힌다.
test('an archive with no browser in it fails instead of being remembered', async () => {
  const zip = makeZip(tmp, [member('readme.txt', 'no browser here')]);
  await assert.rejects(
    () => install(planFor('chromium-1234', ['chrome-linux/chrome']), {}, zipFetch(zip)),
    /no chrome executable/,
  );
  assert.equal(readConfig().chromePath, undefined, 'nothing may be written to the config');
});

test('a failed download does not leave a half-installed directory behind', async () => {
  const failing = (async () => ({ ok: false, status: 503, statusText: 'Unavailable', body: null })) as unknown as typeof fetch;
  await assert.rejects(() => install(planFor('chromium-1234', []), {}, failing), /503/);
  assert.equal(fs.existsSync(path.join(chromeRoot(), 'chromium-1234')), false);
});

// 반쯤 풀린 옛 설치가 남아 있으면 findBinary 가 그것을 집는다.
test('re-installing replaces the previous tree rather than merging into it', async () => {
  const stale = path.join(chromeRoot(), 'chromium-1234');
  fs.mkdirSync(path.join(stale, 'chrome-linux'), { recursive: true });
  fs.writeFileSync(path.join(stale, 'chrome-linux', 'leftover.txt'), 'from an older install');

  const zip = makeZip(tmp, [member('chrome-linux/chrome', '#!/bin/sh\n', 0o100755)]);
  await install(planFor('chromium-1234', ['chrome-linux/chrome']), {}, zipFetch(zip));
  assert.equal(fs.existsSync(path.join(stale, 'chrome-linux', 'leftover.txt')), false);
});

test('the downloaded archive is not left lying around', async () => {
  const zip = makeZip(tmp, [member('chrome-linux/chrome', '#!/bin/sh\n', 0o100755)]);
  await install(planFor('chromium-1234', ['chrome-linux/chrome']), {}, zipFetch(zip));
  const leftovers = fs.readdirSync(chromeRoot()).filter(n => n.startsWith('.download-'));
  assert.deepEqual(leftovers, []);
});
