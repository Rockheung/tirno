// Augment Waypoints with vision-discovered text.
//
// Earlier design (PR #11) added OCR words ONLY when a11y didn't cover them
// (IoU/containedIn filter), producing a "visual-only" ref bucket. That was a
// narrow read of OCR's role.
//
// Real role: OCR is one channel among many for the SAME element. So now:
//   1. for each input Waypoint that has a visual.bbox, attach OCR words
//      contained in that bbox to channels.visual.ocrText (concat by spaces,
//      avg confidence in ocrConf).
//   2. OCR words not contained in any input Waypoint are emitted as
//      orphan Waypoints with only channels.visual populated — caller can
//      decide to keep them as new waypoints (canvas / image-as-text / shadow
//      DOM regions a11y missed).
//
// Output: full Waypoint list (input augmented + orphans), plus stats.

import { recognize, shutdown } from './ocr.js';
import type { BackendName } from './types.js';
import { containedIn } from '../cdp/iou.js';
import type { Waypoint } from '../core/visual-cache.js';

export interface AugmentOptions {
  backend: BackendName;
  lang?: string;
  containThreshold?: number;    // OCR word "contained in" a11y bbox at this fraction → attach
  minConfidence?: number;       // drop OCR words below this confidence
}

export interface AugmentResult {
  refs: Waypoint[];             // input refs (with OCR attached) + orphan refs
  totalOcrWords: number;        // total OCR words above minConfidence
  attached: number;             // OCR words attached to existing a11y waypoint
  orphan: number;               // OCR words emitted as new visual-only waypoints
  durationMs: number;
}

export async function visionAugment(
  pngBuffer: Buffer,
  inputRefs: Waypoint[],
  opts: AugmentOptions,
): Promise<AugmentResult> {
  const containT = opts.containThreshold ?? 0.8;
  const minConf = opts.minConfidence ?? 50;
  const result = await recognize(pngBuffer, opts.backend, { lang: opts.lang });

  // Working copy — we mutate channels.visual.ocrText / ocrConf
  const refs: Waypoint[] = inputRefs.map(r => ({
    ...r,
    channels: {
      ...r.channels,
      visual: r.channels.visual ? { ...r.channels.visual } : undefined,
    },
  }));

  // Buffer OCR matches per ref so we can join + average at the end.
  const buckets: Array<{ texts: string[]; confs: number[] }> = refs.map(() => ({ texts: [], confs: [] }));
  let attached = 0;
  let orphanCount = 0;
  let counter = 0;
  const orphans: Waypoint[] = [];

  for (const w of result.words) {
    if (w.confidence < minConf) continue;

    // find ref whose visual.bbox contains this OCR word (most-specific = smallest bbox wins)
    let bestIdx = -1;
    let bestArea = Infinity;
    for (let i = 0; i < refs.length; i++) {
      const bbox = refs[i].channels.visual?.bbox;
      if (!bbox) continue;
      if (!containedIn(w.bbox, bbox, containT)) continue;
      const area = bbox.w * bbox.h;
      if (area < bestArea) { bestArea = area; bestIdx = i; }
    }

    if (bestIdx >= 0) {
      buckets[bestIdx].texts.push(w.text);
      buckets[bestIdx].confs.push(w.confidence);
      attached++;
    } else {
      counter++;
      orphans.push({
        id: `@v${counter}`,
        refId: `@v${counter}`,
        channels: {
          visual: {
            bbox: w.bbox,
            ocrText: w.text,
            ocrConf: w.confidence,
          },
        },
      });
      orphanCount++;
    }
  }

  // Apply buckets back to refs
  for (let i = 0; i < refs.length; i++) {
    const b = buckets[i];
    if (b.texts.length === 0) continue;
    const ref = refs[i];
    if (!ref.channels.visual) ref.channels.visual = { bbox: { x: 0, y: 0, w: 0, h: 0 } };
    const joined = b.texts.join(' ');
    const avg = Math.round(b.confs.reduce((a, c) => a + c, 0) / b.confs.length);
    ref.channels.visual.ocrText = ref.channels.visual.ocrText
      ? `${ref.channels.visual.ocrText} ${joined}`
      : joined;
    ref.channels.visual.ocrConf = ref.channels.visual.ocrConf !== undefined
      ? Math.round((ref.channels.visual.ocrConf + avg) / 2)
      : avg;
  }

  // Free worker between snapshots
  await shutdown().catch(() => {});

  return {
    refs: [...refs, ...orphans],
    totalOcrWords: result.words.filter(w => w.confidence >= minConf).length,
    attached,
    orphan: orphanCount,
    durationMs: result.durationMs,
  };
}
