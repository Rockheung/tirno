import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { safeJoin, unzip } from '../src/core/unzip.js';

// 브라우저 아카이브는 zip 으로만 배포되는데 node 에도 bun 에도 zip 리더가 없다.
// `unzip` 을 부르면 그것이 곧 새 전제조건이 되므로 직접 읽는다 (#139) — 그러면 그
// 리더가 맞는지도 직접 증명해야 한다. 여기서는 zip 을 손으로 만들어 되읽는다.

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-unzip-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

interface Member {
  name: string;
  data: Buffer;
  /** unix 모드. 심링크는 0o120000 을 켠다. */
  mode: number;
  deflate?: boolean;
}

const crc32 = (b: Buffer): number =>
  typeof (zlib as { crc32?: (b: Buffer) => number }).crc32 === 'function'
    ? (zlib as unknown as { crc32: (b: Buffer) => number }).crc32(b) >>> 0
    : 0;

/** 필요한 필드만 채운 최소 zip 라이터. 테스트 픽스처 전용이다. */
function makeZip(members: Member[]): string {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const m of members) {
    const stored = m.deflate ? zlib.deflateRawSync(m.data) : m.data;
    const nameBuf = Buffer.from(m.name, 'utf-8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(m.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(m.data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(m.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(3 << 8 | 20, 4); // 상위 바이트 3 = unix
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(m.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc32(m.data), 16);
    cd.writeUInt32LE(stored.length, 20);
    cd.writeUInt32LE(m.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(((m.mode & 0xffff) << 16) >>> 0, 38); // << 16 은 int32 를 넘겨 음수가 된다
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const file = path.join(tmp, 'test.zip');
  fs.writeFileSync(file, Buffer.concat([...chunks, centralBuf, eocd]));
  return file;
}

const f = (name: string, body: string, mode = 0o100644, deflate = false): Member =>
  ({ name, data: Buffer.from(body), mode, deflate });

test('stored and deflated members both come back byte-exact', () => {
  const big = 'x'.repeat(5000);
  const zip = makeZip([f('plain.txt', 'hello'), f('packed.txt', big, 0o100644, true)]);
  const dest = path.join(tmp, 'out');
  const result = unzip(zip, dest);
  assert.equal(result.files, 2);
  assert.equal(fs.readFileSync(path.join(dest, 'plain.txt'), 'utf-8'), 'hello');
  assert.equal(fs.readFileSync(path.join(dest, 'packed.txt'), 'utf-8'), big);
});

// 실행 비트를 잃으면 받아온 chrome 이 안 돈다 — 이 기능 전체가 무의미해진다.
test('the executable bit survives', () => {
  const zip = makeZip([f('chrome', '#!/bin/sh\n', 0o100755), f('note.txt', 'x', 0o100644)]);
  const dest = path.join(tmp, 'out');
  unzip(zip, dest);
  assert.equal(fs.statSync(path.join(dest, 'chrome')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(dest, 'note.txt')).mode & 0o777, 0o644);
});

// mac 앱 번들은 심링크로 짜여 있다. 파일로 쓰면 번들이 조용히 깨진다.
test('a symlink member becomes a symlink, not a file holding its target', () => {
  const zip = makeZip([
    f('real/thing', 'contents'),
    { name: 'link', data: Buffer.from('real/thing'), mode: 0o120777 },
  ]);
  const dest = path.join(tmp, 'out');
  const result = unzip(zip, dest);
  assert.equal(result.symlinks, 1);
  assert.equal(fs.lstatSync(path.join(dest, 'link')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(dest, 'link'), 'utf-8'), 'contents');
});

test('nested directories are created as needed', () => {
  const zip = makeZip([f('a/b/c/deep.txt', 'ok')]);
  const dest = path.join(tmp, 'out');
  unzip(zip, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'a/b/c/deep.txt'), 'utf-8'), 'ok');
});

// 남이 만든 zip 을 푸는 코드에서 이 검사가 없으면 그것은 임의 파일 쓰기다.
test('members that would escape the destination are skipped, not written', () => {
  const zip = makeZip([
    f('../escaped.txt', 'nope'),
    f('/absolute.txt', 'nope'),
    f('ok.txt', 'yes'),
  ]);
  const dest = path.join(tmp, 'out');
  const result = unzip(zip, dest);
  assert.equal(fs.existsSync(path.join(tmp, 'escaped.txt')), false);
  assert.ok(result.skipped.includes('../escaped.txt'));
  // 절대경로는 앞의 `/` 를 떼고 안쪽에 쓴다 — 밖으로 나가지만 않으면 된다.
  assert.equal(fs.readFileSync(path.join(dest, 'ok.txt'), 'utf-8'), 'yes');
});

test('safeJoin refuses traversal and accepts ordinary names', () => {
  const dest = '/tmp/x';
  assert.equal(safeJoin(dest, '../../etc/passwd'), null);
  assert.equal(safeJoin(dest, 'a/../../../etc/passwd'), null);
  assert.equal(safeJoin(dest, '.'), null);
  assert.equal(safeJoin(dest, 'a/b.txt'), '/tmp/x/a/b.txt');
  assert.equal(safeJoin(dest, '/abs.txt'), '/tmp/x/abs.txt');
});

test('a file that is not a zip says so instead of writing garbage', () => {
  const notZip = path.join(tmp, 'not.zip');
  fs.writeFileSync(notZip, 'just some bytes');
  assert.throws(() => unzip(notZip, path.join(tmp, 'out')), /Not a zip file/);
});

test('an empty archive extracts nothing and does not throw', () => {
  const zip = makeZip([]);
  const result = unzip(zip, path.join(tmp, 'out'));
  assert.equal(result.files, 0);
});
