// Detached worker for `tirno screencast start`. Holds a CDP session, writes
// frames to disk, and finalizes index.json on SIGTERM. Spawned with --ws
// (browser WS endpoint) and --out (dir).

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

interface FrameEntry { n: number; ts: string; file: string }

interface Args {
  ws: string;
  out: string;
  format: 'png' | 'jpeg';
  quality: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNth: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ws = get('--ws') ?? '';
  const out = get('--out') ?? '';
  const format = (get('--format') ?? 'png') as 'png' | 'jpeg';
  const quality = Number(get('--quality') ?? 80);
  const maxWidth = get('--max-width') ? Number(get('--max-width')) : undefined;
  const maxHeight = get('--max-height') ? Number(get('--max-height')) : undefined;
  const everyNth = Math.max(1, Number(get('--every-nth') ?? 1));
  if (!ws || !out) {
    process.stderr.write('worker: --ws and --out required\n');
    process.exit(2);
  }
  return { ws, out, format, quality, maxWidth, maxHeight, everyNth };
}

async function main(): Promise<void> {
  const args = parseArgs();
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

  const browser = await puppeteer.connect({ browserWSEndpoint: args.ws });
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

    if (n++ % args.everyNth !== 0) {
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

main().catch(e => {
  process.stderr.write(`worker: ${(e as Error).message}\n`);
  process.exit(1);
});
