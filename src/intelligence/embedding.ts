// Semantic embedding pipeline.
//
// Uses @huggingface/transformers (already a dep) with all-MiniLM-L6-v2
// (384 dim, ~25MB ONNX). Lazy-loaded — first call downloads model into
// ~/.cache/huggingface (or TIRNO_MODELS_DIR).
//
// Output: Float32Array(384), L2-normalized so cosine = dot product.

import path from 'node:path';
import os from 'node:os';
import type { Waypoint } from '../core/visual-cache.js';

const DEFAULT_MODEL = process.env.TIRNO_EMBED_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

type Extractor = (text: string | string[], opts?: any) => Promise<{ data: Float32Array | number[] }>;

let cached: Extractor | null = null;

async function getExtractor(): Promise<Extractor> {
  if (cached) return cached;
  const tx = await import('@huggingface/transformers');
  const cacheDir = process.env.TIRNO_MODELS_DIR
    ? path.join(process.env.TIRNO_MODELS_DIR, 'embeddings')
    : path.join(os.homedir(), '.tirno', 'models', 'embeddings');
  (tx as any).env.cacheDir = cacheDir;
  const pipeline = (tx as any).pipeline as (task: string, model: string) => Promise<Extractor>;
  cached = await pipeline('feature-extraction', DEFAULT_MODEL);
  return cached!;
}

export async function embed(text: string): Promise<Float32Array> {
  const e = await getExtractor();
  const out = await e(text, { pooling: 'mean', normalize: true });
  // out.data is either Float32Array or number[]; normalize to Float32Array
  return out.data instanceof Float32Array
    ? out.data
    : Float32Array.from(out.data);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const e = await getExtractor();
  const out = await e(texts, { pooling: 'mean', normalize: true });
  // batch output: dims = [batch, dim]. data is flat.
  const dim = EMBEDDING_DIM;
  const flat = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return result;
}

/**
 * Build the text used for embedding a waypoint. Includes URL context so
 * different sites' "submit" buttons don't all collapse together.
 */
export function buildEmbedText(wp: Waypoint, urlContext?: string): string {
  const parts: string[] = [];
  if (urlContext) parts.push(urlContext);
  const a = wp.channels.a11y;
  const d = wp.channels.dom;
  const v = wp.channels.visual;
  if (a?.role) parts.push(a.role);
  if (a?.name) parts.push(a.name);
  if (a?.description) parts.push(a.description);
  if (d?.selector) parts.push(d.selector);
  if (v?.ocrText) parts.push(v.ocrText);
  return parts.join(' ').slice(0, 500);
}

/**
 * Cosine similarity between two normalized vectors.
 * If both are L2-normalized, this equals dot product.
 */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
