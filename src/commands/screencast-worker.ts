// Detached worker for `tirno screencast start`. Holds a CDP session, writes
// frames to disk, and finalizes index.json on SIGTERM. Spawned with --ws
// (browser WS endpoint) and --out (dir).

import fs from 'node:fs';
import path from 'node:path';
import { Browser } from '../cdp/browser.js';

interface FrameEntry { n: number; ts: string; file: string }

export interface ScreencastWorkerOptions {
  ws: string;
  out: string;
  format: 'png' | 'jpeg';
  quality: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNth: number;
}

export async function runScreencastWorker(args: ScreencastWorkerOptions): Promise<void> {
  const everyNth = Math.max(1, args.everyNth);
  const frames: FrameEntry[] = [];
  let n = 0;
  let dropped = 0;

  // Persist progress on signal — flush index.json then exit clean.
  const finalize = (): void => {
    try {
      fs.writeFileSync(path.join(args.out, 'index.json'), JSON.stringify({
        format: args.format,
        startedAt: frames[0]?.ts,
        endedAt: frames.at(-1)?.ts,
        count: frames.length,
        dropped,
        frames,
      }, null, 2));
    } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on('SIGTERM', finalize);
  process.on('SIGINT', finalize);

  const browser = await Browser.connect(args.ws);
  const pages = await browser.pages();
  const page = pages.find(p => !p.url().startsWith('about:')) ?? pages[0];
  if (!page) {
    process.stderr.write('worker: no page targets\n');
    process.exit(3);
  }
  const cdp = await page.createCDPSession();

  cdp.on('Page.screencastFrame', async (params) => {
    const p = params as unknown as { data: string; sessionId: number; metadata: { timestamp?: number } };
    try {
      // Always ack so CDP keeps streaming.
      await cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId });
    } catch { /* CDP may have closed */ }

    if (n++ % everyNth !== 0) {
      dropped++;
      return;
    }
    const idx = frames.length;
    const file = `frame-${String(idx).padStart(6, '0')}.${args.format}`;
    fs.writeFileSync(path.join(args.out, file), Buffer.from(p.data, 'base64'));
    frames.push({
      n: idx,
      ts: new Date((p.metadata.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
      file,
    });

    // Periodically flush index.json so a crash leaves a usable snapshot.
    if (idx % 30 === 0) {
      try {
        fs.writeFileSync(path.join(args.out, 'index.json'), JSON.stringify({
          format: args.format,
          startedAt: frames[0]?.ts,
          count: frames.length,
          dropped,
          frames,
        }, null, 2));
      } catch { /* best-effort */ }
    }
  });

  await cdp.send('Page.startScreencast', {
    format: args.format,
    quality: args.format === 'jpeg' ? args.quality : undefined,
    maxWidth: args.maxWidth,
    maxHeight: args.maxHeight,
    everyNthFrame: 1, // we filter on our side via everyNth so frame numbers stay sane
  });

  // Idle forever — wait for SIGTERM.
  await new Promise(() => { /* block */ });
}
