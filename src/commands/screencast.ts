// `tirno screencast start | stop` — captures Page.screencastFrame events
// to a frames directory. Internally spawns a detached child node process
// that holds the CDP listener (tirno itself is one-shot, so the child is
// the only way to keep the trace alive between invocations).
//
// The child writes:
//   <out>/frame-NNNNNN.<ext>  — frames as captured
//   <out>/index.json          — list of {n, ts, file}
//   <out>/.pid                 — child PID
//
// `screencast stop` sends SIGTERM to the child PID; the child finalizes
// index.json and exits. ffmpeg can stitch frames into mp4 — instructions
// printed at stop time.

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import * as store from '../core/session-store.js';
import { success, info, error } from '../output/formatter.js';

const DEFAULT_OUT_BASE = path.join(os.tmpdir(), 'tirno-screencast');

export function registerScreencastCommands(program: Command): void {
  const cmd = program
    .command('screencast')
    .description('Capture page frames as PNG/JPEG sequence (daemonized — start then stop)');

  cmd
    .command('start')
    .description('Start a screencast capture in a detached worker')
    .option('-s, --session <name>', 'Session name')
    .option('--out <dir>', 'Output directory (default: <tmpdir>/tirno-screencast-<ts>)')
    .option('--format <fmt>', 'png | jpeg (default png)', 'png')
    .option('--quality <0-100>', 'JPEG quality (jpeg only)', (v: string) => parseInt(v, 10), 80)
    .option('--max-width <px>', 'Max frame width', (v: string) => parseInt(v, 10))
    .option('--max-height <px>', 'Max frame height', (v: string) => parseInt(v, 10))
    .option('--every-nth <n>', 'Keep every Nth frame (1 = all)', (v: string) => parseInt(v, 10), 1)
    .action(async (opts) => {
      try {
        const meta = resolveSession(opts.session);
        const outDir = opts.out ?? `${DEFAULT_OUT_BASE}-${Date.now()}`;
        fs.mkdirSync(outDir, { recursive: true });
        const pidFile = path.join(outDir, '.pid');

        if (fs.existsSync(pidFile)) {
          const old = Number(fs.readFileSync(pidFile, 'utf-8'));
          if (Number.isFinite(old) && pidAlive(old)) {
            throw new Error(`Screencast already running (PID ${old}) at ${outDir} — run \`tirno screencast stop --out ${outDir}\` first`);
          }
        }

        const workerScript = path.join(import.meta.url.startsWith('file://')
          ? new URL('.', import.meta.url).pathname
          : __dirname,
          'screencast-worker.js'
        );

        const child = spawn(process.execPath, [
          workerScript,
          '--ws', meta.wsEndpoint,
          '--out', outDir,
          '--format', opts.format,
          '--quality', String(opts.quality ?? 80),
          ...(opts.maxWidth ? ['--max-width', String(opts.maxWidth)] : []),
          ...(opts.maxHeight ? ['--max-height', String(opts.maxHeight)] : []),
          '--every-nth', String(opts.everyNth ?? 1),
        ], {
          detached: true,
          stdio: ['ignore', 'ignore', fs.openSync(path.join(outDir, 'worker.log'), 'a')],
        });
        child.unref();

        if (typeof child.pid !== 'number') throw new Error('Failed to spawn worker');
        fs.writeFileSync(pidFile, String(child.pid));
        success(`Screencast started (PID ${child.pid}) — frames → ${outDir}`);
        info(`Stop with: tirno screencast stop --out ${outDir}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('stop')
    .description('Stop a running screencast and finalize index.json')
    .option('--out <dir>', 'Screencast directory created by start')
    .action(async (opts) => {
      try {
        const outDir = opts.out;
        if (!outDir) throw new Error('--out <dir> is required (use the dir printed by `screencast start`)');
        const pidFile = path.join(outDir, '.pid');
        if (!fs.existsSync(pidFile)) throw new Error(`No screencast worker registered at ${outDir}`);
        const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
        if (!Number.isFinite(pid)) throw new Error('Corrupt .pid');

        if (pidAlive(pid)) {
          process.kill(pid, 'SIGTERM');
          // wait up to 5s for graceful exit (worker writes index.json then exits)
          const deadline = Date.now() + 5000;
          while (pidAlive(pid) && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 100));
          }
          if (pidAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
          }
        }
        try { fs.unlinkSync(pidFile); } catch { /* ok */ }

        const idxPath = path.join(outDir, 'index.json');
        let frameCount = 0;
        if (fs.existsSync(idxPath)) {
          try {
            const idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')) as { frames?: unknown[] };
            frameCount = idx.frames?.length ?? 0;
          } catch { /* corrupt — ignore */ }
        }
        success(`Screencast stopped (${frameCount} frames in ${outDir})`);
        info(`To stitch: ffmpeg -framerate 30 -i ${outDir}/frame-%06d.png -pix_fmt yuv420p ${outDir}/out.mp4`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}

function resolveSession(name?: string): store.SessionMetadata {
  if (name) return store.get(name);
  const active = store.getActive();
  if (!active) throw new Error('No active session — pass --session or run `tirno attach`');
  return store.get(active);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
