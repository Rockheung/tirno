import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { dHash, hammingDistance } from '../src/cdp/screenshot-hash.js';

function makePng(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const [r, g, b] = fill(x, y);
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test('dHash returns 16 hex chars (64 bits)', async () => {
  const buf = makePng(20, 20, () => [128, 128, 128]);
  const h = await dHash(buf);
  assert.equal(h.length, 16);
  assert.match(h, /^[0-9a-f]{16}$/);
});

test('dHash is deterministic for identical input', async () => {
  const buf = makePng(50, 50, (x, y) => [x * 5, y * 5, 0]);
  const h1 = await dHash(buf);
  const h2 = await dHash(buf);
  assert.equal(h1, h2);
});

test('dHash differs for different patterns', async () => {
  // dHash compares row-wise (left vs right). vertical gradient → all zeros (row-constant).
  // pick patterns that produce row-wise variation.
  const leftRightSplit = makePng(50, 50, (x) => x < 25 ? [0, 0, 0] : [255, 255, 255]);
  const checker = makePng(50, 50, (x, y) => ((x >> 3) + (y >> 3)) & 1 ? [0, 0, 0] : [255, 255, 255]);
  const h1 = await dHash(leftRightSplit);
  const h2 = await dHash(checker);
  assert.notEqual(h1, h2);
});

test('dHash for solid color is all zeros (no left>right pixels)', async () => {
  const buf = makePng(30, 30, () => [200, 200, 200]);
  const h = await dHash(buf);
  assert.equal(h, '0000000000000000');
});

test('hammingDistance: identical hashes → 0', () => {
  assert.equal(hammingDistance('abcd1234', 'abcd1234'), 0);
});

test('hammingDistance: single bit difference → 1', () => {
  // 0x0 vs 0x1 differ by 1 bit
  assert.equal(hammingDistance('0000000000000000', '0000000000000001'), 1);
});

test('hammingDistance: full inversion (64 bits) → 64', () => {
  assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
});

test('hammingDistance: length mismatch returns -1', () => {
  assert.equal(hammingDistance('abcd', 'abcd1234'), -1);
});

// pageFingerprint — 웹 페이지용 (#188). 9x8 최근접 dHash 는 1080p 에서 점이 여백에 떨어져
// example.com 이 전부 0 이었다. 면적 평균 16x16 은 셀이 블록의 글자 밀도를 담는다.
// 임계값 32 가 근거 없는 숫자로 남지 않게 여기서 관계를 고정한다.
import { pageFingerprint, fingerprintBits } from '../src/cdp/screenshot-hash.js';

/** 흰 바탕에 검은 "글줄" 들 — 웹 페이지 흉내 */
function page(width: number, height: number, blocks: Array<[number, number, number, number]>, shift = 0): Buffer {
  return makePng(width, height, (x, y) => {
    for (const [bx, by, bw, bh] of blocks) {
      if (x >= bx + shift && x < bx + bw + shift && y >= by && y < by + bh) return [0, 0, 0];
    }
    return [255, 255, 255];
  });
}
const TEXT: Array<[number, number, number, number]> = [
  [40, 40, 300, 20], [40, 80, 260, 12], [40, 100, 280, 12], [40, 120, 200, 12], [40, 200, 320, 12], [40, 220, 150, 12],
];

test('pageFingerprint 는 256 비트(hex 64자)고, 빈 페이지가 아니면 0 이 아니다', async () => {
  const fp = await pageFingerprint(page(400, 300, TEXT));
  assert.equal(fp.length, 64);
  assert.equal(fingerprintBits(fp), 256);
  assert.notEqual(fp, '0'.repeat(64));
});

test('같은 페이지 0 · 1% 밀린 페이지 < 32 · 반전 ≥ 128 · 모달 얹힘 > 32', async () => {
  const a = await pageFingerprint(page(400, 300, TEXT));
  const same = await pageFingerprint(page(400, 300, TEXT));
  const shifted = await pageFingerprint(page(400, 300, TEXT, 4));
  const inverted = await pageFingerprint(makePng(400, 300, (x, y) => {
    for (const [bx, by, bw, bh] of TEXT) if (x >= bx && x < bx + bw && y >= by && y < by + bh) return [255, 255, 255];
    return [0, 0, 0];
  }));
  const modal = await pageFingerprint(page(400, 300, [...TEXT, [100, 60, 200, 180]]));

  assert.equal(hammingDistance(a, same), 0);
  assert.ok(hammingDistance(a, shifted) < 32, `shift: ${hammingDistance(a, shifted)}`);
  assert.ok(hammingDistance(a, inverted) >= 128, `inverted: ${hammingDistance(a, inverted)}`);
  assert.ok(hammingDistance(a, modal) > 32, `modal: ${hammingDistance(a, modal)}`);
});

test('옛 dHash(16자)와 새 지문은 비교할 수 없다 — -1', async () => {
  const buf = page(400, 300, TEXT);
  assert.equal(hammingDistance(await dHash(buf), await pageFingerprint(buf)), -1);
});
