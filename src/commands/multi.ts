import { Command } from 'commander';
import { floatArg } from '../util/parsers.js';
import fs from 'node:fs';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, info, error } from '../output/formatter.js';
import * as store from '../core/session-store.js';

export function registerMultiCommands(program: Command): void {
  program
    .command('diff')
    .description('Visual diff between two sessions')
    .argument('<session1>', 'First session')
    .argument('<session2>', 'Second session')
    .option('--out <path>', 'Output diff image path')
    .option('--threshold <n>', 'Color difference threshold (0-1)', floatArg, 0.1)
    .action(async (s1: string, s2: string, opts) => {
      try {
        // take screenshots from both sessions
        const shot1 = await takeSessionScreenshot(s1);
        const shot2 = await takeSessionScreenshot(s2);

        // dynamic import for pixelmatch + pngjs
        const { PNG } = await import('pngjs');
        const pixelmatch = (await import('pixelmatch')).default;

        const img1 = PNG.sync.read(shot1);
        const img2 = PNG.sync.read(shot2);

        // resize to match if different
        const width = Math.min(img1.width, img2.width);
        const height = Math.min(img1.height, img2.height);

        const diff = new PNG({ width, height });
        const mismatch = pixelmatch(
          img1.data, img2.data, diff.data,
          width, height,
          { threshold: opts.threshold }
        );

        const totalPixels = width * height;
        const pct = ((mismatch / totalPixels) * 100).toFixed(1);

        const outPath = opts.out ?? `/tmp/tirno-diff-${Date.now()}.png`;
        fs.writeFileSync(outPath, PNG.sync.write(diff));

        success(`Diff: ${mismatch} pixels (${pct}%) — ${outPath}`);
        if (mismatch === 0) info('Identical screenshots');
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command('broadcast')
    .description('Run a command on all sessions (or a group)')
    .argument('<cmd>', 'Command to run (nav, screenshot, eval, ...)')
    .argument('[args...]', 'Command arguments')
    .option('--group <name>', 'Limit to sessions in this group')
    .action(async (cmd: string, args: string[], opts) => {
      let sessions = store.list();
      if (opts.group) sessions = sessions.filter(s => s.group === opts.group);
      if (sessions.length === 0) {
        info(opts.group ? `No sessions in group '${opts.group}'` : 'No sessions');
        return;
      }

      for (const session of sessions) {
        info(`[${session.name}] tirno ${cmd} ${args.join(' ')}`);
        try {
          // re-execute tirno with -s flag
          const { execSync } = await import('node:child_process');
          const result = execSync(
            `node ${process.argv[1]} ${cmd} ${args.join(' ')} -s ${session.name}`,
            { encoding: 'utf-8', timeout: 30000 }
          );
          process.stdout.write(result);
        } catch (e) {
          error(`[${session.name}] ${(e as Error).message}`);
        }
      }
    });
}

async function takeSessionScreenshot(sessionName: string): Promise<Buffer> {
  const { browser } = await connect(sessionName);
  const page = await getActivePage(browser);
  const buffer = await page.screenshot({ type: 'png', optimizeForSpeed: true });
  browser.disconnect();
  return buffer as Buffer;
}
