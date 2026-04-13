import { Command } from 'commander';
import fs from 'node:fs';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { writeScreenshot } from '../output/image-writer.js';
import { success, info, error } from '../output/formatter.js';

export function registerPerfCommands(program: Command): void {
  const trace = program
    .command('trace')
    .description('Performance tracing');

  trace
    .command('start')
    .description('Start a performance trace')
    .option('-s, --session <name>', 'Session name')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        await page.tracing.start({
          screenshots: true,
          categories: [
            'devtools.timeline',
            'v8.execute',
            'blink.user_timing',
            'loading',
            'devtools.timeline.async',
          ],
        });

        browser.disconnect();
        success('Trace started. Use "chromux trace stop" to save.');
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  trace
    .command('stop')
    .description('Stop tracing and save')
    .option('-s, --session <name>', 'Session name')
    .option('--out <path>', 'Output file path')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        const buffer = await page.tracing.stop();
        browser.disconnect();

        if (!buffer) {
          info('No trace data');
          return;
        }

        const outPath = opts.out ?? `/tmp/chromux-trace-${Date.now()}.json`;
        fs.writeFileSync(outPath, buffer);
        success(`Trace saved: ${outPath} (open in chrome://tracing)`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('memory')
    .description('Take a heap snapshot')
    .option('-s, --session <name>', 'Session name')
    .option('--out <path>', 'Output file path')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const cdp = await page.createCDPSession();

        const chunks: string[] = [];
        cdp.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
          chunks.push((params as unknown as { chunk: string }).chunk);
        });

        await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
        await cdp.detach();
        browser.disconnect();

        const outPath = opts.out ?? `/tmp/chromux-heap-${Date.now()}.heapsnapshot`;
        fs.writeFileSync(outPath, chunks.join(''));
        success(`Heap snapshot: ${outPath} (open in Chrome DevTools Memory tab)`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
