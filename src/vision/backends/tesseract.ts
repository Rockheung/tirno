import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { OcrBackend, OcrResult, OcrOptions, OcrWord } from '../types.js';

function modelsDir(): string {
  const dir = process.env.TIRNO_MODELS_DIR
    ? path.join(process.env.TIRNO_MODELS_DIR, 'tesseract')
    : path.join(os.homedir(), '.tirno', 'models', 'tesseract');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let worker: import('tesseract.js').Worker | null = null;
let currentLang: string | null = null;

async function getWorker(lang: string): Promise<import('tesseract.js').Worker> {
  if (worker && currentLang === lang) return worker;
  if (worker) {
    await worker.terminate().catch(() => {});
    worker = null;
  }
  const tesseract = await import('tesseract.js');
  const cachePath = modelsDir();
  worker = await tesseract.createWorker(lang, 1, { cachePath } as unknown as Parameters<typeof tesseract.createWorker>[2]);
  currentLang = lang;
  return worker;
}

export const tesseractBackend: OcrBackend = {
  name: 'tesseract.js',

  async recognize(pngBuffer: Buffer, opts: OcrOptions = {}): Promise<OcrResult> {
    const lang = opts.lang ?? 'eng';
    const start = Date.now();
    const w = await getWorker(lang);
    const out = await w.recognize(pngBuffer, {}, { blocks: true });
    const durationMs = Date.now() - start;

    type Bbox = { x0: number; y0: number; x1: number; y1: number };
    type Word = { text: string; confidence: number; bbox: Bbox };
    type Line = { words?: Word[] };
    type Paragraph = { lines?: Line[] };
    type Block = { paragraphs?: Paragraph[] };

    const words: OcrWord[] = [];
    const blocks = (out.data as { blocks?: Block[] }).blocks ?? [];
    for (const block of blocks) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          for (const wd of line.words ?? []) {
            if (!wd.text || !wd.text.trim()) continue;
            words.push({
              text: wd.text,
              bbox: {
                x: Math.round(wd.bbox.x0),
                y: Math.round(wd.bbox.y0),
                w: Math.round(wd.bbox.x1 - wd.bbox.x0),
                h: Math.round(wd.bbox.y1 - wd.bbox.y0),
              },
              confidence: Math.round(wd.confidence),
            });
          }
        }
      }
    }

    return {
      text: out.data.text.trim(),
      words,
      durationMs,
      backend: 'tesseract.js',
    };
  },

  async shutdown(): Promise<void> {
    if (worker) {
      await worker.terminate().catch(() => {});
      worker = null;
      currentLang = null;
    }
  },
};
