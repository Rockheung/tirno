// Backend dispatcher. Backends are loaded lazily so unused ones don't pull in
// their (potentially large) native dependencies.

import type { OcrBackend, OcrOptions, OcrResult, BackendName } from './types.js';

export type { OcrWord, OcrResult, OcrOptions, OcrBackend, BackendName } from './types.js';

const BACKENDS: Record<BackendName, () => Promise<OcrBackend>> = {
  tesseract: async () => (await import('./backends/tesseract.js')).tesseractBackend,
  paddle: async () => (await import('./backends/paddle.js')).paddleBackend,
  florence: async () => {
    const mod = await import('./backends/florence.js').catch(() => null);
    if (!mod) throw new Error('Florence backend not available — install dependencies or rebuild');
    return mod.florenceBackend;
  },
};

const loaded = new Map<BackendName, OcrBackend>();

export async function getBackend(name: BackendName): Promise<OcrBackend> {
  let b = loaded.get(name);
  if (b) return b;
  b = await BACKENDS[name]();
  loaded.set(name, b);
  return b;
}

export async function recognize(
  pngBuffer: Buffer,
  backend: BackendName,
  opts: OcrOptions = {},
): Promise<OcrResult> {
  const b = await getBackend(backend);
  return b.recognize(pngBuffer, opts);
}

export async function shutdown(): Promise<void> {
  await Promise.all(Array.from(loaded.values()).map(b => b.shutdown().catch(() => {})));
  loaded.clear();
}
