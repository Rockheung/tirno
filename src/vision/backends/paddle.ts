// PaddleOCR backend via @gutenye/ocr-node (onnxruntime-node + sharp).
// Default is English. For Korean, supply --models pointing to PaddleOCR Korean
// det/rec/dict paths.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { OcrBackend, OcrResult, OcrOptions, OcrWord } from '../types.js';

interface PaddleLine {
  text: string;
  mean: number;
  box?: [number, number][];
}

interface PaddleOcr {
  detect(image: string, options?: object): Promise<PaddleLine[]>;
}

interface PaddleModelPaths {
  detectionPath: string;
  recognitionPath: string;
  dictionaryPath: string;
}

let instance: PaddleOcr | null = null;
let lastModelKey = '';

async function getInstance(modelPaths?: PaddleModelPaths): Promise<PaddleOcr> {
  const key = modelPaths ? JSON.stringify(modelPaths) : '__default__';
  if (instance && lastModelKey === key) return instance;
  const mod = (await import('@gutenye/ocr-node')) as { default: { create(opts?: { models?: PaddleModelPaths }): Promise<PaddleOcr> } };
  instance = await mod.default.create(modelPaths ? { models: modelPaths } : undefined);
  lastModelKey = key;
  return instance!;
}

function bboxFromPolygon(box?: [number, number][]): { x: number; y: number; w: number; h: number } {
  if (!box || box.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = box.map(p => p[0]);
  const ys = box.map(p => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(Math.max(...xs) - x),
    h: Math.round(Math.max(...ys) - y),
  };
}

export interface PaddleOptions extends OcrOptions {
  // optional Korean (or other lang) model paths
  models?: PaddleModelPaths;
}

export const paddleBackend: OcrBackend = {
  name: 'paddleocr (@gutenye/ocr-node)',
  kind: 'local',

  async recognize(pngBuffer: Buffer, opts: PaddleOptions = {}): Promise<OcrResult> {
    const start = Date.now();
    const tmp = path.join(os.tmpdir(), `tirno-paddle-${crypto.randomBytes(6).toString('hex')}.png`);
    fs.writeFileSync(tmp, pngBuffer);
    try {
      const ocr = await getInstance(opts.models);
      const lines = await ocr.detect(tmp);
      const durationMs = Date.now() - start;

      const words: OcrWord[] = lines.map(l => ({
        text: l.text,
        bbox: bboxFromPolygon(l.box),
        confidence: Math.round((l.mean ?? 0) * 100),
      }));

      return {
        text: words.map(w => w.text).join('\n').trim(),
        words,
        durationMs,
        backend: 'paddleocr',
      };
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  },

  async shutdown(): Promise<void> {
    instance = null;
    lastModelKey = '';
  },
};
