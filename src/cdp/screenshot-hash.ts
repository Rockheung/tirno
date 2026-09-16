// dHash perceptual hash — 9x8 grayscale → 64bit hex.
// **웹 페이지에는 쓰지 않는다** — 최근접 표본이 여백에 떨어져 지문이 거의 0 이 된다.
// 캐시는 아래 pageFingerprint 를 쓴다. 이것은 작은 이미지(요소 영역) 비교용으로 남긴다.
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

/** 같은 길이의 hex 지문 둘의 비트 거리. 길이가 다르면 -1 — 비교할 수 없다는 뜻이다. */
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

/**
 * 웹 페이지용 지문 — 16x16 **면적 평균** 그레이 → 전체 평균보다 밝은가 (aHash), 256비트 hex 64자.
 *
 * 위의 dHash 는 9x8 **최근접 표본**이라, 1920x1080 페이지에서 한 줄에 점 9개를 찍는다.
 * 그 점은 거의 언제나 여백에 떨어져 example.com 은 `0000000000000000`, HN 은 `80808080…`
 * (주황 헤더 한 비트) 이 됐다 — 정보가 없는 지문 위에 낡음 판정을 얹으면 "fresh" 오탐이
 * 조용한 실패가 된다 (#188). 면적 평균은 셀 하나가 213x135 블록의 글자 밀도를 담는다.
 *
 * 실측(1920x1080): 같은 페이지 0 · 같은 레이아웃 다른 글(HN front vs newest) 12 ·
 * 모달 얹힘 59 · 다른 사이트 85–130. 기본 임계 32 는 "레이아웃이 같으면 fresh, 위에
 * 무언가 덮이면 stale" 자리다.
 */
export const PAGE_FP_GRID = 16;

export async function pageFingerprint(pngBuffer: Buffer): Promise<string> {
  const { PNG } = await import('pngjs');
  const { width, height, data } = PNG.sync.read(pngBuffer);
  const G = PAGE_FP_GRID;
  const cells = new Float64Array(G * G);
  // 2픽셀 걸음 — 정확도는 충분하고 1080p 에서 4배 빠르다
  const step = width * height > 500_000 ? 2 : 1;
  for (let gy = 0; gy < G; gy++) {
    const y0 = Math.floor(gy * height / G), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * height / G));
    for (let gx = 0; gx < G; gx++) {
      const x0 = Math.floor(gx * width / G), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * width / G));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (y * width + x) * 4;
          sum += (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
          n++;
        }
      }
      cells[gy * G + gx] = sum / n;
    }
  }
  let mean = 0;
  for (const v of cells) mean += v;
  mean /= cells.length;
  let bits = 0n;
  for (const v of cells) bits = (bits << 1n) | (v > mean ? 1n : 0n);
  return bits.toString(16).padStart(G * G / 4, '0');
}

/** 지문 형식 — 길이로 가른다. 옛 dHash(16자)와 새 aHash(64자)는 비교할 수 없다. */
export function fingerprintBits(fp: string): number {
  return fp.length * 4;
}
