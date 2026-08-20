// Backend dispatcher. Backends are loaded lazily so unused ones don't pull in
// their (potentially large) native or cloud-SDK dependencies.

import type { OcrBackend, OcrOptions, OcrResult, BackendName } from './types.js';

export type { OcrWord, OcrResult, OcrOptions, OcrBackend, BackendName } from './types.js';
export { LOCAL_BACKENDS, CLOUD_BACKENDS, ALL_BACKENDS, DEFAULT_BACKEND } from './types.js';

const BACKENDS: Record<BackendName, () => Promise<OcrBackend>> = {
  // local
  tesseract: async () => (await import('./backends/tesseract.js')).tesseractBackend,
  paddle: async () => (await import('./backends/paddle.js')).paddleBackend,
  florence: async () => {
    const mod = await import('./backends/florence.js').catch(() => null);
    if (!mod) throw new Error('Florence backend not available — install dependencies or rebuild');
    return mod.florenceBackend;
  },
  // cloud (stubs — Phase 6-2f)
  claude: async () => (await import('./backends/claude.js')).claudeBackend,
  openai: async () => (await import('./backends/openai.js')).openaiBackend,
  gemini: async () => (await import('./backends/gemini.js')).geminiBackend,
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
