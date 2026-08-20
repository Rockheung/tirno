// OpenAI GPT-4o Vision backend (stub).
// Real implementation: see Phase 6-2f. Requires OPENAI_API_KEY.

import type { OcrBackend } from '../types.js';

const ENV_KEY = 'OPENAI_API_KEY';

export const openaiBackend: OcrBackend = {
  name: 'openai vision (stub)',
  kind: 'cloud',

  async recognize(): Promise<never> {
    if (!process.env[ENV_KEY]) {
      throw new Error(
        `openai backend requires ${ENV_KEY} env var. ` +
        `Real implementation pending — use --backend paddle or tesseract for local OCR.`
      );
    }
    throw new Error(
      `openai backend is not yet implemented. Tracked in Phase 6-2f. ` +
      `Use --backend paddle (local, default) or other backend.`
    );
  },

  async shutdown(): Promise<void> { /* nothing */ },
};
