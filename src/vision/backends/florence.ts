// Florence-2 backend via @huggingface/transformers (transformers.js).
// Vision-language model — supports OCR + OCR_WITH_REGION + OD + DENSE_REGION_CAPTION.
// First load downloads ~150MB-1GB depending on dtype. Inference is CPU only on Node.
//
// STATUS: experimental — model loads + generate runs, but the task token
// (<OCR_WITH_REGION>) is not preserved correctly through tokenize→decode in
// transformers.js v4 (raw output drops the leading "OC", reading "R_WITH_REGION"),
// causing post_process_generation to return empty/garbled regions on
// `onnx-community/Florence-2-base-ft`. Use --backend paddle for
// production OCR. Configurable via env:
//   TIRNO_FLORENCE_MODEL=<hf-id>     (default: onnx-community/Florence-2-base-ft)
//   TIRNO_FLORENCE_DTYPE=q4|q8|fp32  (default: q4)
//   TIRNO_FLORENCE_DEBUG=1           (print raw decoded text to stderr)

import path from 'node:path';
import os from 'node:os';
import type { OcrBackend, OcrOptions, OcrResult, OcrWord } from '../types.js';

const MODEL_ID = process.env.TIRNO_FLORENCE_MODEL ?? 'onnx-community/Florence-2-base-ft';
const TASK = '<OCR_WITH_REGION>';

interface FlorenceModel {
  generate(opts: Record<string, unknown>): Promise<unknown>;
}
interface FlorenceProcessor {
  (image: unknown): Promise<Record<string, unknown>>;
  // Florence post_process_generation expects [height, width]
  post_process_generation(text: string, task: string, size: [number, number]): Record<string, { quad_boxes?: number[][]; labels?: string[] }>;
}
interface FlorenceTokenizer {
  (input: string): Record<string, unknown>;
  batch_decode(ids: unknown, opts?: { skip_special_tokens?: boolean }): string[];
}

let model: FlorenceModel | null = null;
let processor: FlorenceProcessor | null = null;
let tokenizer: FlorenceTokenizer | null = null;

async function init(): Promise<void> {
  if (model && processor && tokenizer) return;

  const tx = await import('@huggingface/transformers');
  const cacheDir = process.env.TIRNO_MODELS_DIR
    ? path.join(process.env.TIRNO_MODELS_DIR, 'florence')
    : path.join(os.homedir(), '.tirno', 'models', 'florence');

  // env.cacheDir for hub downloads
  (tx.env as { cacheDir?: string }).cacheDir = cacheDir;

  type Florence2Cls = {
    from_pretrained(id: string, opts?: { dtype?: string; device?: string }): Promise<FlorenceModel>;
  };
  type AutoCls<T> = {
    from_pretrained(id: string): Promise<T>;
  };

  const Florence2 = (tx as unknown as { Florence2ForConditionalGeneration: Florence2Cls }).Florence2ForConditionalGeneration;
  const AutoProc = (tx as unknown as { AutoProcessor: AutoCls<FlorenceProcessor> }).AutoProcessor;
  const AutoTok = (tx as unknown as { AutoTokenizer: AutoCls<FlorenceTokenizer> }).AutoTokenizer;

  // dtype 'q4' for compactness; fp16 has known onnxruntime graph fusion bugs.
  // Configurable via TIRNO_FLORENCE_DTYPE (q4 | q8 | fp32).
  const dtype = process.env.TIRNO_FLORENCE_DTYPE ?? 'q4';
  model = await Florence2.from_pretrained(MODEL_ID, { dtype });
  processor = await AutoProc.from_pretrained(MODEL_ID);
  tokenizer = await AutoTok.from_pretrained(MODEL_ID);
}

export const florenceBackend: OcrBackend = {
  name: 'florence-2 (transformers.js)',
  kind: 'local',

  async recognize(pngBuffer: Buffer, _opts: OcrOptions = {}): Promise<OcrResult> {
    const start = Date.now();
    await init();
    if (!model || !processor || !tokenizer) throw new Error('Florence-2 init failed');

    const tx = await import('@huggingface/transformers');
    type RawImageCls = { fromBlob(blob: Blob): Promise<{ width: number; height: number; size: [number, number] }> };
    const RawImageRef = (tx as unknown as { RawImage: RawImageCls }).RawImage;

    const image = await RawImageRef.fromBlob(new Blob([new Uint8Array(pngBuffer)]));

    const text_inputs = tokenizer(TASK);
    const vision_inputs = await processor(image);

    const generated_ids = await model.generate({
      ...text_inputs,
      ...vision_inputs,
      max_new_tokens: 1024,
    });

    const generated_text = tokenizer.batch_decode(generated_ids, { skip_special_tokens: false })[0];
    if (process.env.TIRNO_FLORENCE_DEBUG) {
       
      console.error('[florence raw]', JSON.stringify(generated_text));
    }
    // post_process expects [height, width]
    const parsed = processor.post_process_generation(generated_text, TASK, [image.height, image.width]);
    const durationMs = Date.now() - start;

    const data = parsed[TASK] ?? {};
    const words: OcrWord[] = [];
    const quad_boxes = data.quad_boxes ?? [];
    const labels = data.labels ?? [];
    for (let i = 0; i < labels.length; i++) {
      const box = quad_boxes[i] ?? [];
      if (box.length < 8) continue;
      const xs = [box[0], box[2], box[4], box[6]];
      const ys = [box[1], box[3], box[5], box[7]];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      words.push({
        text: labels[i],
        bbox: {
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(Math.max(...xs) - x),
          h: Math.round(Math.max(...ys) - y),
        },
        confidence: 100, // Florence doesn't expose per-region confidence
      });
    }

    return {
      text: words.map(w => w.text).join('\n').trim(),
      words,
      durationMs,
      backend: 'florence-2',
    };
  },

  async shutdown(): Promise<void> {
    model = null;
    processor = null;
    tokenizer = null;
  },
};
