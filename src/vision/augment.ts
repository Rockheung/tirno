// Augment a11y refs with vision-discovered text. Runs OCR on the page
// screenshot, then keeps only words that don't overlap meaningfully with
// any existing a11y bbox (IoU < threshold). Output: visual-only CacheRef[]
// with @vN ids.

import { recognize, shutdown } from './ocr.js';
import type { BackendName } from './types.js';
import { iou, containedIn, type Bbox } from '../cdp/iou.js';
import type { CacheRef } from '../core/visual-cache.js';

export interface AugmentOptions {
  backend: BackendName;
  lang?: string;
  iouThreshold?: number;        // overlap threshold for "already covered" (vision↔vision overlap)
  containThreshold?: number;    // vision word "contained in" a11y bbox at this fraction → covered
  minConfidence?: number;       // drop OCR words below this confidence
}

export interface AugmentResult {
  refs: CacheRef[];
  totalOcrWords: number;
  durationMs: number;
}

export async function visionAugment(
  pngBuffer: Buffer,
  a11yBboxes: Bbox[],
  opts: AugmentOptions,
): Promise<AugmentResult> {
  const iouT = opts.iouThreshold ?? 0.3;
  const containT = opts.containThreshold ?? 0.8;
  const minConf = opts.minConfidence ?? 50;
  const result = await recognize(pngBuffer, opts.backend, { lang: opts.lang });
  const refs: CacheRef[] = [];
  let counter = 0;
  for (const w of result.words) {
    if (w.confidence < minConf) continue;
    // covered if either: contained in any a11y bbox (broad container case), or
    // high IoU with any a11y bbox (peer-level overlap)
    const covered = a11yBboxes.some(b => containedIn(w.bbox, b, containT) || iou(b, w.bbox) >= iouT);
    if (covered) continue;
    counter++;
    refs.push({
      refId: `@v${counter}`,
      role: 'text',
      name: w.text,
      bbox: w.bbox,
      source: 'vision',
      confidence: w.confidence,
    });
  }
  // Free worker between snapshots; cheaper than holding it across processes
  await shutdown().catch(() => {});
  return {
    refs,
    totalOcrWords: result.words.length,
    durationMs: result.durationMs,
  };
}
