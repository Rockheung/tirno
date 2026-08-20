// dHash perceptual hash — 9x8 grayscale → 64bit hex
// resilient to small rendering differences, sensitive to layout change
export async function dHash(pngBuffer: Buffer): Promise<string> {
  const { PNG } = await import('pngjs');
  const img = PNG.sync.read(pngBuffer);
  const { width, height, data } = img;

  // resize to 9x8 grayscale via nearest-neighbor sampling
  const W = 9;
  const H = 8;
  const gray = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(width - 1, Math.floor((x + 0.5) * width / W));
      const sy = Math.min(height - 1, Math.floor((y + 0.5) * height / H));
      const idx = (sy * width + sx) * 4;
      // luminance approximation
      gray[y * W + x] = (data[idx] * 299 + data[idx + 1] * 587 + data[idx + 2] * 114) / 1000;
    }
  }

  // compare each pixel to the next on its row → 8x8 = 64 bits
  let bits = 0n;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const left = gray[y * W + x];
      const right = gray[y * W + x + 1];
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return -1;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
