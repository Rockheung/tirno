// Florence-2 backend via @huggingface/transformers (transformers.js).
// Stub — implementation in next PR. Listed in dispatcher so CLI surface is
// stable from this PR onward.

import type { OcrBackend } from '../types.js';

export const florenceBackend: OcrBackend = {
  name: 'florence-2 (transformers.js)',

  async recognize(): Promise<never> {
    throw new Error(
      'florence backend is not yet implemented. Use --backend tesseract or --backend paddle.\n' +
      'Tracked in next PR (Phase 6-2c).'
    );
  },

  async shutdown(): Promise<void> {
    /* nothing to release */
  },
};
