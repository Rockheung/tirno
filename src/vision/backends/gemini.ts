// Google Gemini Vision backend (stub).
// Real implementation: see Phase 6-2f. Requires GOOGLE_API_KEY (or GEMINI_API_KEY).

import type { OcrBackend } from '../types.js';

const ENV_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];

export const geminiBackend: OcrBackend = {
  name: 'gemini vision (stub)',
  kind: 'cloud',

  async recognize(): Promise<never> {
    const present = ENV_KEYS.find(k => process.env[k]);
    if (!present) {
      throw new Error(
        `gemini backend requires one of ${ENV_KEYS.join(' / ')} env var. ` +
        `Real implementation pending — use --backend paddle for local OCR.`
      );
    }
    throw new Error(
      `gemini backend is not yet implemented. Tracked in Phase 6-2f. ` +
      `Use --backend paddle (local, default) or other backend.`
    );
  },

  async shutdown(): Promise<void> { /* nothing */ },
};
