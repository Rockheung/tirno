// Anthropic Claude Vision backend (stub).
// Real implementation: see Phase 6-2f. Requires ANTHROPIC_API_KEY.
//
// Planned: send screenshot + prompt asking for OCR result as structured JSON
// (text + rough bbox per region). Pixel-precise bbox is weak in VLMs — pair
// with local paddle OCR for accurate coords if needed.

import type { OcrBackend } from '../types.js';

const ENV_KEY = 'ANTHROPIC_API_KEY';

export const claudeBackend: OcrBackend = {
  name: 'claude vision (stub)',
  kind: 'cloud',

  async recognize(): Promise<never> {
    if (!process.env[ENV_KEY]) {
      throw new Error(
        `claude backend requires ${ENV_KEY} env var. ` +
        `Real implementation pending — use --backend paddle or tesseract for local OCR.`
      );
    }
    throw new Error(
      `claude backend is not yet implemented. Tracked in Phase 6-2f. ` +
      `Use --backend paddle (local, default) or other backend.`
    );
  },

  async shutdown(): Promise<void> { /* nothing */ },
};
