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
