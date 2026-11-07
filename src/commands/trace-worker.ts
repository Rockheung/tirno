// Detached worker for `tirno trace start`. Holds a CDP session that's running
// Tracing.start, waits for SIGTERM, then collects the buffered events into a
// trace.json file. Required because CDP tracing is bound to the session that
// started it — tirno is one-shot, so a daemon worker is the only way to split
// start/stop into two CLI invocations.
//
// Spawned with --ws (browser WS endpoint), --out (trace file path), and
// optional --categories.

import fs from 'node:fs';
import { Browser } from '../cdp/browser.js';

export interface TraceWorkerOptions {
  ws: string;
  out: string;
  categories?: string;
  screenshots?: boolean;
}

const DEFAULT_CATEGORIES = [
  'devtools.timeline',
  'v8.execute',
  'blink.user_timing',
  'loading',
  'devtools.timeline.async',
];

export async function runTraceWorker(args: TraceWorkerOptions): Promise<void> {
  const browser = await Browser.connect(args.ws);
  const pages = await browser.pages();
  const page = pages.find(p => !p.url().startsWith('about:')) ?? pages[0];
  if (!page) {
    process.stderr.write('trace-worker: no page targets\n');
    process.exit(3);
  }

  let finalizing = false;
  const finalize = async (): Promise<void> => {
    if (finalizing) return;
    finalizing = true;
    try {
      const buffer = await page.tracing.stop();
      if (buffer) {
        fs.writeFileSync(args.out, buffer);
        // Tag start/end markers next to the file so `trace stop` can report stats.
        try {
          const stat = fs.statSync(args.out);
          fs.writeFileSync(`${args.out}.meta.json`, JSON.stringify({
            sizeBytes: stat.size,
            finalizedAt: new Date().toISOString(),
          }, null, 2));
        } catch { /* best-effort */ }
      } else {
        fs.writeFileSync(args.out, '');
      }
    } catch (e) {
      try {
        fs.writeFileSync(`${args.out}.error`, (e as Error).message);
      } catch { /* best-effort */ }
    }
    try { await browser.disconnect(); } catch { /* ok */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void finalize(); });
  process.on('SIGINT', () => { void finalize(); });

  await page.tracing.start({
    screenshots: args.screenshots,
    categories: args.categories?.split(',').filter(Boolean) ?? DEFAULT_CATEGORIES,
  });

  // Mark "started" so `trace stop` can see the worker is past startup.
  fs.writeFileSync(`${args.out}.started`, new Date().toISOString());

  await new Promise(() => { /* idle forever until SIGTERM */ });
}
