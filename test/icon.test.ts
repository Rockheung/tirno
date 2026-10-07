import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brandBundle, bundleResources, iconFileName, icnsBytes } from '../src/core/icon.js';

// darwin 이 아닌 CI 에서도 돈다 — `platform` 을 넘겨 쓰기 경로를 그대로 증명한다.
// 여기서 증명하는 것은 **어디에 쓰는가와 어디에 안 쓰는가** 이고, 독에 어떻게 보이는지가
// 아니다. 그쪽은 사람 눈이 본다.

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-icon-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** `~/.tirno/chrome/<label>/chrome-mac-arm64/X.app/Contents/MacOS/X` 를 흉내 낸다. */
function fakeBundle(root: string, appName = 'Google Chrome for Testing', iconKey?: string): string {
  const app = path.join(root, 'chrome-mac-arm64', `${appName}.app`);
  const macos = path.join(app, 'Contents', 'MacOS');
  const resources = path.join(app, 'Contents', 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  const binary = path.join(macos, appName);
  fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(resources, 'app.icns'), 'google의 원본');
  if (iconKey !== undefined) {
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'),
      `<plist><dict><key>CFBundleIconFile</key><string>${iconKey}</string></dict></plist>`);
  }
  return binary;
}

test('bundleResources: .app 모양일 때만 Resources 를 돌려준다', () => {
  const binary = fakeBundle(tmp);
  assert.equal(bundleResources(binary), path.join(path.dirname(path.dirname(binary)), 'Resources'));
  assert.equal(bundleResources('/usr/bin/chromium'), null);
  assert.equal(bundleResources('/opt/chrome-linux64/chrome'), null);
});

test('iconFileName: Info.plist 가 말하는 이름을 쓰고, 확장자가 없으면 붙인다', () => {
  const withKey = fakeBundle(tmp, 'A', 'brand');          // 확장자 없음
  assert.equal(iconFileName(bundleResources(withKey)!), 'brand.icns');

  const spelled = fakeBundle(path.join(tmp, 'b'), 'B', 'spelled.icns');
  assert.equal(iconFileName(bundleResources(spelled)!), 'spelled.icns');

  const noPlist = fakeBundle(path.join(tmp, 'c'), 'C');   // plist 자체가 없다
  assert.equal(iconFileName(bundleResources(noPlist)!), 'app.icns');
});

test('우리가 받은 번들에는 아이콘을 입힌다', () => {
  const root = path.join(tmp, 'chrome');
  const binary = fakeBundle(root);
  const before = fs.statSync(path.dirname(path.dirname(path.dirname(binary)))).mtimeMs;

  const outcome = brandBundle(binary, { root, platform: 'darwin' });
  assert.equal(outcome.done, true);

  const written = fs.readFileSync(path.join(path.dirname(path.dirname(binary)), 'Resources', 'app.icns'));
  assert.equal(written.subarray(0, 4).toString('ascii'), 'icns');
  assert.ok(written.length > 1000, '원본 자리에 진짜 .icns 가 들어가야 한다');
  // 독·Finder 가 아이콘 캐시를 무르는 신호다.
  assert.ok(fs.statSync(path.dirname(path.dirname(path.dirname(binary)))).mtimeMs >= before);
});

test('우리가 받지 않은 브라우저는 건드리지 않는다 — 사용자의 평소 크롬이 같이 바뀐다', () => {
  const elsewhere = path.join(tmp, 'Applications');
  const binary = fakeBundle(elsewhere, 'Google Chrome');
  const icns = path.join(path.dirname(path.dirname(binary)), 'Resources', 'app.icns');

  const outcome = brandBundle(binary, { root: path.join(tmp, 'chrome'), platform: 'darwin' });
  assert.equal(outcome.done, false);
  assert.equal(outcome.done === false && outcome.reason, 'not-ours');
  assert.equal(fs.readFileSync(icns, 'utf-8'), 'google의 원본', '남의 아이콘은 그대로여야 한다');
});

test('macOS 가 아니면 아무것도 안 한다', () => {
  const root = path.join(tmp, 'chrome');
  const binary = fakeBundle(root);
  const outcome = brandBundle(binary, { root, platform: 'linux' });
  assert.equal(outcome.done, false);
  assert.equal(outcome.done === false && outcome.reason, 'not-macos');
});

test('박아 둔 아이콘은 길이까지 맞는 .icns 다', () => {
  const bytes = icnsBytes();
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'icns');
  // icns 헤더의 두 번째 워드가 파일 전체 길이다. 잘려 들어갔으면 여기서 걸린다.
  assert.equal(bytes.readUInt32BE(4), bytes.length);
});
