import { Command } from 'commander';
import { intArg } from '../util/parsers.js';
import fs from 'node:fs';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { recognize, shutdown } from '../vision/ocr.js';
import { ALL_BACKENDS, LOCAL_BACKENDS, CLOUD_BACKENDS, DEFAULT_BACKEND, type BackendName } from '../vision/types.js';
import { success, info, error } from '../output/formatter.js';

const BACKEND_HELP = `OCR backend\n  local:  ${LOCAL_BACKENDS.join(' | ')}\n  cloud:  ${CLOUD_BACKENDS.join(' | ')} (require API keys, stub — Phase 6-2f)`;

export function registerVisionCommands(program: Command): void {
  const vision = program
    .command('vision')
    .description('OCR / visual extraction (Phase 6-2)');

  vision
    .command('ocr')
    .description('Run OCR on the current page screenshot')
    .option('-s, --session <name>', 'Session name')
    .option('--backend <name>', BACKEND_HELP, DEFAULT_BACKEND)
    .option('--lang <lang>', 'Language hint (paddle: eng default; supply --paddle-models <dir> for other langs)', 'eng')
    .option('--full', 'Full page screenshot (default: viewport only)')
    .option('--out <path>', 'Write JSON result to path')
    .option('--min-confidence <n>', 'Filter words below this confidence (0-100)', intArg, 0)
    .option('--paddle-models <dir>', 'Directory containing PaddleOCR det/rec/dict for non-default langs')
    .action(async (opts) => {
      try {
        const backend = opts.backend as BackendName;
        if (!ALL_BACKENDS.includes(backend)) {
          throw new Error(`Unknown backend "${backend}". Valid: ${ALL_BACKENDS.join(', ')}`);
        }

        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const buf = await page.screenshot({
          type: 'png',
          fullPage: opts.full ?? false,
          optimizeForSpeed: true,
        }) as Buffer;
        browser.disconnect();

        if (backend === 'florence') {
          info('florence backend is experimental — output decoding may be incomplete (see backends/florence.ts for status)');
        }
        info(`Running OCR (backend=${backend}, lang=${opts.lang}, ${(buf.length / 1024).toFixed(0)}KB)...`);

        const ocrOpts: Record<string, unknown> = { lang: opts.lang };
        if (backend === 'paddle' && opts.paddleModels) {
          ocrOpts.models = {
            detectionPath: `${opts.paddleModels}/det.onnx`,
            recognitionPath: `${opts.paddleModels}/rec.onnx`,
            dictionaryPath: `${opts.paddleModels}/dict.txt`,
          };
        }

        const result = await recognize(buf, backend, ocrOpts);
        await shutdown();

        const filtered = result.words.filter(w => w.confidence >= opts.minConfidence);
        const out = {
          backend: result.backend,
          lang: opts.lang,
          durationMs: result.durationMs,
          totalWords: result.words.length,
          filteredWords: filtered.length,
          text: result.text,
          words: filtered,
        };

        if (opts.out) {
          fs.writeFileSync(opts.out, JSON.stringify(out, null, 2));
          success(`${opts.out} (${filtered.length} words, ${result.durationMs}ms)`);
        } else {
          console.log(`# backend: ${result.backend}  lang: ${opts.lang}  duration: ${result.durationMs}ms`);
          console.log(`# words: ${filtered.length} (filtered from ${result.words.length}, min-confidence ${opts.minConfidence})`);
          console.log('');
          for (const w of filtered) {
            const conf = w.confidence.toString().padStart(3, ' ');
            console.log(`[${conf}%] (${w.bbox.x},${w.bbox.y} ${w.bbox.w}x${w.bbox.h})  ${w.text}`);
          }
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
