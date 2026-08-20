// Backend-agnostic OCR interface. First implementation: tesseract.js (light,
// supports ko/en, no native deps). Other backends (PaddleOCR via onnxruntime,
// Florence-2 via transformers.js) can be added behind the same interface.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function modelsDir(): string {
  const dir = process.env.TIRNO_MODELS_DIR ?? path.join(os.homedir(), '.tirno', 'models', 'tesseract');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface OcrWord {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number; // 0-100
}

export interface OcrResult {
  text: string;        // joined text
  words: OcrWord[];
  durationMs: number;
  backend: string;
}

export interface OcrOptions {
  lang?: string;       // tesseract langs joined with '+', e.g. 'kor+eng'
  // future: backend, model path, threshold, etc.
}

let tesseractWorker: import('tesseract.js').Worker | null = null;
let currentLang: string | null = null;

async function getWorker(lang: string): Promise<import('tesseract.js').Worker> {
  if (tesseractWorker && currentLang === lang) return tesseractWorker;
  if (tesseractWorker) {
    await tesseractWorker.terminate().catch(() => {});
    tesseractWorker = null;
  }
  const tesseract = await import('tesseract.js');
  const cachePath = modelsDir();
  tesseractWorker = await tesseract.createWorker(lang, 1, { cachePath } as unknown as Parameters<typeof tesseract.createWorker>[2]);
  currentLang = lang;
  return tesseractWorker;
}

export async function recognize(pngBuffer: Buffer, opts: OcrOptions = {}): Promise<OcrResult> {
  const lang = opts.lang ?? 'eng';
  const start = Date.now();
  const worker = await getWorker(lang);
  const out = await worker.recognize(pngBuffer, {}, { blocks: true });
  const durationMs = Date.now() - start;

  const words: OcrWord[] = [];
  // tesseract.js v7+ word access is via blocks → paragraphs → lines → words
  type Bbox = { x0: number; y0: number; x1: number; y1: number };
  type Word = { text: string; confidence: number; bbox: Bbox };
  type Line = { words?: Word[] };
  type Paragraph = { lines?: Line[] };
  type Block = { paragraphs?: Paragraph[] };

  const blocks = (out.data as { blocks?: Block[] }).blocks ?? [];
  for (const block of blocks) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          if (!w.text || !w.text.trim()) continue;
          words.push({
            text: w.text,
            bbox: {
              x: Math.round(w.bbox.x0),
              y: Math.round(w.bbox.y0),
              w: Math.round(w.bbox.x1 - w.bbox.x0),
              h: Math.round(w.bbox.y1 - w.bbox.y0),
            },
            confidence: Math.round(w.confidence),
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
}

export async function shutdown(): Promise<void> {
  if (tesseractWorker) {
    await tesseractWorker.terminate().catch(() => {});
    tesseractWorker = null;
    currentLang = null;
  }
}
