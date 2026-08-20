// Intelligence backend dispatcher — same pattern as vision/ocr.ts.

import type {
  IntelligenceBackend,
  IntelligenceRequest,
  IntelligenceResponse,
  BackendName,
} from './types.js';
import { withResilience, type ResilienceOptions } from './resilience.js';

const BACKENDS: Record<BackendName, () => Promise<IntelligenceBackend>> = {
  claude: async () => (await import('./backends/claude.js')).claudeBackend,
  openai: async () => {
    throw new Error('openai intelligence backend not yet implemented (Phase next).');
  },
  gemini: async () => {
    throw new Error('gemini intelligence backend not yet implemented (Phase next).');
  },
};

const loaded = new Map<BackendName, IntelligenceBackend>();

export async function getIntelligence(name: BackendName): Promise<IntelligenceBackend> {
  let b = loaded.get(name);
  if (b) return b;
  b = await BACKENDS[name]();
  loaded.set(name, b);
  return b;
}

export async function ask(
  backend: BackendName,
  req: IntelligenceRequest,
  resilience?: ResilienceOptions,
): Promise<IntelligenceResponse> {
  const b = await getIntelligence(backend);
  if (!b.available) {
    throw new Error(`${backend} intelligence backend not available — check API key env var.`);
  }
  return withResilience(() => b.ask(req), resilience);
}

export { resetSessionState, getSessionCost } from './resilience.js';
export type { ResilienceOptions } from './resilience.js';
