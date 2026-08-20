// Intelligence backend dispatcher — same pattern as vision/ocr.ts.

import type {
  IntelligenceBackend,
  IntelligenceRequest,
  IntelligenceResponse,
  BackendName,
} from './types.js';
import { withResilience, type ResilienceOptions } from './resilience.js';
import { emit } from '../core/metrics.js';

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
  const start = Date.now();
  try {
    const res = await withResilience(() => b.ask(req), {
      ...resilience,
      onRetry: (attempt, err) => {
        emit('llm.retry', { backend, attempt, errorPreview: err.message.slice(0, 100) });
        if (resilience?.onRetry) resilience.onRetry(attempt, err);
      },
    });
    emit('llm.call', {
      backend,
      ms: Date.now() - start,
      goal: req.goal,
      ask: req.ask,
      inputTokens: res.usage?.inputTokens,
      outputTokens: res.usage?.outputTokens,
      costUsd: res.usage?.estimatedCostUsd,
      hasScreenshot: !!req.context.screenshot,
      a11yLines: req.context.a11yDump?.split('\n').length ?? 0,
      ragHits: req.context.nearbyWaypoints?.length ?? 0,
      confidence: res.confidence,
    });
    return res;
  } catch (e) {
    emit('llm.fail', { backend, ms: Date.now() - start, error: (e as Error).message.slice(0, 200) });
    throw e;
  }
}

export { resetSessionState, getSessionCost } from './resilience.js';
export type { ResilienceOptions } from './resilience.js';
