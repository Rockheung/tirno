import { Command } from 'commander';
import { floatArg, intArg } from '../util/parsers.js';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import * as store from '../core/session-store.js';

import { success, info, error } from '../output/formatter.js';
import { formatTable } from '../output/formatter.js';

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

interface TraceEvent {
  cat?: string;
  name?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  args?: Record<string, unknown>;
}

function readTraceJson(path: string): { traceEvents: TraceEvent[]; metadata?: unknown } {
  const raw = fs.readFileSync(path);
  const text = path.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf-8') : raw.toString('utf-8');
  const parsed = JSON.parse(text);
  if (!parsed.traceEvents || !Array.isArray(parsed.traceEvents)) {
    throw new Error('Not a valid trace JSON (missing traceEvents)');
  }
  return parsed;
}

interface HeapMeta {
  node_fields: string[];
  node_types: unknown[];
  edge_fields: string[];
}
interface HeapSnapshot {
  meta: HeapMeta;
  nodes: number[];
  strings: string[];
  totalSize: number;
  nodeCount: number;
}
function readHeapSnapshot(path: string): HeapSnapshot {
  const raw = fs.readFileSync(path, 'utf-8');
  const json = JSON.parse(raw);
  if (!json.snapshot || !json.nodes || !json.strings) {
    throw new Error('Not a valid heap snapshot (.heapsnapshot)');
  }
  const meta = json.snapshot.meta as HeapMeta;
  const nodes: number[] = json.nodes;
  const strings: string[] = json.strings;
  const fieldCount = meta.node_fields.length;
  const sizeIdx = meta.node_fields.indexOf('self_size');
  let totalSize = 0;
  if (sizeIdx >= 0) {
    for (let i = sizeIdx; i < nodes.length; i += fieldCount) totalSize += nodes[i];
  }
  return { meta, nodes, strings, totalSize, nodeCount: nodes.length / fieldCount };
}

interface HeapBucket { type: string; name: string; count: number; size: number }
function aggregateHeapByType(s: HeapSnapshot): HeapBucket[] {
  const fieldCount = s.meta.node_fields.length;
  const typeIdx = s.meta.node_fields.indexOf('type');
  const nameIdx = s.meta.node_fields.indexOf('name');
  const sizeIdx = s.meta.node_fields.indexOf('self_size');
  const nodeTypes = s.meta.node_types?.[0] as string[] | undefined;
  const buckets = new Map<string, HeapBucket>();
  for (let i = 0; i < s.nodes.length; i += fieldCount) {
    const typeId = s.nodes[i + typeIdx];
    const nameId = s.nodes[i + nameIdx];
    const size = s.nodes[i + sizeIdx];
    const type = nodeTypes?.[typeId] ?? `type${typeId}`;
    const name = type === 'object' ? (s.strings[nameId] ?? '(anonymous)') : '';
    const key = `${type}|${name}`;
    const b = buckets.get(key) ?? { type, name, count: 0, size: 0 };
    b.count += 1;
    b.size += size;
    buckets.set(key, b);
  }
  return Array.from(buckets.values()).sort((a, b) => b.size - a.size);
}

export function registerPerfCommands(program: Command): void {
  program
    .command('stall')
    .description('Is the main thread saturated, and what is eating it? Measures from outside the renderer, so it keeps reporting even when the page is wedged')
    .option('-s, --session <name>', 'Session name')
    .option('--window <s>', 'How long to watch, in seconds', floatArg, 10)
    .option('--json', 'Output the samples and summary as JSON')
    .action(async (opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const rendererCdp = await page.createCDPSession();
        // Layer 3 lives on the browser target, on its own socket. That is the
        // whole point: a renderer can be pinned at 100% while the browser
        // process answers in milliseconds, and the gap between the two is what
        // proves the renderer is the problem rather than the machine.
        const browserCdp = await browser.target().createCDPSession();

        // Counters accumulate from `enable`, so the first read is the baseline
        // and every later one is a delta against it.
        await rendererCdp.send('Performance.enable');

        const readMetrics = async (): Promise<Record<string, number>> => {
          const { metrics } = await rendererCdp.send('Performance.getMetrics') as { metrics: Array<{ name: string; value: number }> };
          return Object.fromEntries(metrics.map(m => [m.name, m.value]));
        };

        // A round trip has to wait behind whatever is already queued on the main
        // thread, so its duration IS the queue wait. Nothing clever needed.
        const rtt = async (send: () => Promise<unknown>): Promise<number> => {
          const t0 = Date.now();
          try { await send(); } catch { return Number.NaN; }
          return Date.now() - t0;
        };

        const samples: Array<{ t: number; rendererRttMs: number; browserRttMs: number; taskPct: number; scriptPct: number; layoutPct: number; stylePct: number }> = [];
        let prev = await readMetrics();
        let prevAt = Date.now();
        const started = Date.now();
        const windowMs = opts.window * 1000;

        if (!opts.json) info(`Watching for ${opts.window}s — renderer vs browser round trips, and where the time goes`);

        while (Date.now() - started < windowMs) {
          await new Promise(r => setTimeout(r, 1000));
          const rendererRttMs = await rtt(() => rendererCdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }));
          const browserRttMs = await rtt(() => browserCdp.send('Browser.getVersion'));
          const now = await readMetrics();
          const at = Date.now();
          const span = (at - prevAt) / 1000;
          const pct = (k: string) => span > 0 ? ((now[k] ?? 0) - (prev[k] ?? 0)) / span * 100 : 0;
          const s = {
            t: Number(((at - started) / 1000).toFixed(1)),
            rendererRttMs,
            browserRttMs,
            taskPct: Number(pct('TaskDuration').toFixed(1)),
            scriptPct: Number(pct('ScriptDuration').toFixed(1)),
            layoutPct: Number(pct('LayoutDuration').toFixed(1)),
            stylePct: Number(pct('RecalcStyleDuration').toFixed(1)),
          };
          samples.push(s);
          prev = now; prevAt = at;
          if (!opts.json) {
            console.log(
              `  ${String(s.t).padStart(5)}s  renderer=${String(Number.isNaN(s.rendererRttMs) ? 'no answer' : `${s.rendererRttMs}ms`).padStart(9)}` +
              `  browser=${String(s.browserRttMs).padStart(5)}ms  task=${String(s.taskPct).padStart(5)}%` +
              `  script=${String(s.scriptPct).padStart(5)}%  layout=${String(s.layoutPct).padStart(5)}%  style=${String(s.stylePct).padStart(5)}%`
            );
          }
        }

        await rendererCdp.detach().catch(() => {});
        await browserCdp.detach().catch(() => {});
        browser.disconnect();

        const max = (k: keyof typeof samples[0]) => samples.reduce((m, s) => Math.max(m, Number(s[k]) || 0), 0);
        const taskMax = max('taskPct');
        const rendererMax = max('rendererRttMs');
        const browserMax = max('browserRttMs');
        const scriptMax = max('scriptPct');
        const layoutMax = max('layoutPct');
        const styleMax = max('stylePct');

        // Two different failures hide under "the page is slow", and only both
        // numbers together tell them apart: a queue that is backed up (round
        // trips crawl) versus a flood of short tasks (CPU pinned, round trips
        // still fine). Reading one alone gets the second case wrong.
        let verdict: string;
        if (rendererMax >= 200) verdict = 'queue backed up — the UI is frozen and DevTools will not open';
        else if (taskMax >= 90) verdict = 'short-task flood — CPU is pinned (fans, battery) but input still lands';
        else if (taskMax >= 50) verdict = 'heavy but not stuck — will be felt on slower hardware';
        else verdict = 'idle enough';

        const blame = scriptMax >= layoutMax + styleMax
          ? 'script (JS logic)'
          : (layoutMax + styleMax) > 0 ? 'layout/style (thrashing — the getComputedStyle / getBoundingClientRect signature)'
          : 'neither script nor layout — GC, raster or parsing, which these counters do not split';

        if (opts.json) {
          console.log(JSON.stringify({ samples, summary: { taskMax, scriptMax, layoutMax, styleMax, rendererRttMaxMs: rendererMax, browserRttMaxMs: browserMax, verdict, blame } }, null, 2));
          return;
        }

        console.log('');
        info(`renderer round trip up to ${rendererMax}ms · browser stayed at ${browserMax}ms`);
        // Only worth saying when the renderer actually stalled. A 9ms renderer
        // next to a 1ms browser is not an asymmetry, it is two healthy numbers.
        if (rendererMax >= 200 && browserMax < rendererMax / 4) {
          info('the browser kept answering while the renderer did not — this page, not the machine');
        }
        info(`worst second: task ${taskMax}% (script ${scriptMax}%, layout ${layoutMax}%, style ${styleMax}%)`);
        success(`${verdict} · biggest share: ${blame}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  const traceCmd = program
    .command('trace')
    .description('Run a performance trace for a fixed duration; subcommands for analysis')
    .option('-s, --session <name>', 'Session name')
    .option('--duration <s>', 'Trace duration in seconds', floatArg, 5)
    .option('--out <path>', 'Output file path')
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

        info(`Tracing for ${opts.duration}s...`);
        await new Promise(r => setTimeout(r, opts.duration * 1000));

        const buffer = await page.tracing.stop();
        browser.disconnect();

        if (!buffer) {
          info('No trace data');
          return;
        }

        const outPath = opts.out ?? `/tmp/tirno-trace-${Date.now()}.json`;
        fs.writeFileSync(outPath, buffer);
        success(`Trace saved: ${outPath} (open in chrome://tracing)`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  traceCmd
    .command('start')
    .description('Start a performance trace in a detached worker (manual stop with `trace stop`)')
    .argument('[path]', 'Output trace file path (default: /tmp/tirno-trace-<ts>.json)')
    .option('-s, --session <name>', 'Session name')
    .option('--categories <list>', 'Comma-separated trace categories (override defaults)')
    .option('--screenshots', 'Include screenshots in trace', true)
    .option('--no-screenshots', "Don't include screenshots")
    .action((pathArg: string | undefined, opts) => {
      try {
        const meta = resolveSession(opts.session);
        const outPath = pathArg ?? `/tmp/tirno-trace-${Date.now()}.json`;
        const pidFile = `${outPath}.pid`;

        if (fs.existsSync(pidFile)) {
          const old = Number(fs.readFileSync(pidFile, 'utf-8'));
          if (Number.isFinite(old) && pidAlive(old)) {
            throw new Error(`Trace already running (PID ${old}) writing to ${outPath} — run \`tirno trace stop --out ${outPath}\` first`);
          }
        }

        const workerScript = path.join(import.meta.url.startsWith('file://')
          ? new URL('.', import.meta.url).pathname
          : __dirname,
          'trace-worker.js',
        );

        const args = [
          workerScript,
          '--ws', meta.wsEndpoint,
          '--out', outPath,
          ...(opts.categories ? ['--categories', opts.categories] : []),
          ...(opts.screenshots ? ['--screenshots'] : []),
        ];
        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: ['ignore', 'ignore', fs.openSync(`${outPath}.log`, 'a')],
        });
        child.unref();

        if (typeof child.pid !== 'number') throw new Error('Failed to spawn trace worker');
        fs.writeFileSync(pidFile, String(child.pid));
        success(`Trace started (PID ${child.pid}) → ${outPath}`);
        info(`Stop with: tirno trace stop ${outPath}`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  traceCmd
    .command('stop')
    .description('Stop a running trace started with `trace start`')
    .argument('<path>', 'Trace file path (the one given to/printed by `trace start`)')
    .action(async (pathArg: string) => {
      try {
        const outPath = pathArg;
        if (!outPath) throw new Error('<path> is required (use the path printed by `trace start`)');
        const pidFile = `${outPath}.pid`;
        if (!fs.existsSync(pidFile)) throw new Error(`No trace worker registered for ${outPath}`);
        const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
        if (!Number.isFinite(pid)) throw new Error('Corrupt .pid');

        if (pidAlive(pid)) {
          process.kill(pid, 'SIGTERM');
          // tracing can hold a few MB of buffered events — give worker up to 15s
          // to flush before escalating.
          const deadline = Date.now() + 15000;
          while (pidAlive(pid) && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 100));
          }
          if (pidAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
          }
        }
        try { fs.unlinkSync(pidFile); } catch { /* ok */ }
        // worker writes <out>.started on launch and <out>.meta.json on finalize;
        // clean up the marker but keep the meta file for reporting.
        try { fs.unlinkSync(`${outPath}.started`); } catch { /* ok */ }

        let size = 0;
        try { size = fs.statSync(outPath).size; } catch { /* no file */ }
        if (size === 0) {
          info(`Trace stopped — but no data written to ${outPath} (worker may have died early; check ${outPath}.log)`);
          return;
        }
        success(`Trace saved: ${outPath} (${(size / 1024).toFixed(1)} KB — analyze with \`tirno trace insight ${outPath}\`)`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  traceCmd
    .command('insight')
    .description('Analyze a saved trace.json — extract LCP / FCP / CLS / long tasks')
    .argument('<path>', 'Trace JSON file (.json or .json.gz)')
    .option('--json', 'Output as JSON instead of table')
    .action((path: string, opts) => {
      try {
        const trace = readTraceJson(path);
        const events = trace.traceEvents;

        // FCP / LCP — paint events
        let fcpMs: number | null = null;
        let lcpMs: number | null = null;
        let domContentLoadedMs: number | null = null;
        let loadMs: number | null = null;
        let navStartTs: number | null = null;
        let cls = 0;
        const longTasks: Array<{ ts: number; dur: number; name: string }> = [];

        for (const e of events) {
          if (e.name === 'navigationStart' && navStartTs === null) navStartTs = e.ts ?? null;
        }

        for (const e of events) {
          const ts = e.ts ?? 0;
          const baseMs = navStartTs !== null ? (ts - navStartTs) / 1000 : ts / 1000;

          if (e.name === 'firstContentfulPaint' && fcpMs === null) {
            fcpMs = baseMs;
          }
          if (e.name === 'largestContentfulPaint::Candidate') {
            lcpMs = baseMs; // last candidate wins
          }
          if (e.name === 'MarkDOMContent' && domContentLoadedMs === null) {
            domContentLoadedMs = baseMs;
          }
          if (e.name === 'MarkLoad' && loadMs === null) {
            loadMs = baseMs;
          }
          if (e.name === 'LayoutShift') {
            const args = e.args as { data?: { had_recent_input?: boolean; score?: number } } | undefined;
            const data = args?.data;
            if (data && !data.had_recent_input && typeof data.score === 'number') {
              cls += data.score;
            }
          }
          if (e.name === 'RunTask' && (e.dur ?? 0) > 50_000) {
            longTasks.push({ ts: baseMs, dur: (e.dur ?? 0) / 1000, name: e.name });
          }
        }

        const summary = {
          eventCount: events.length,
          firstContentfulPaintMs: fcpMs,
          largestContentfulPaintMs: lcpMs,
          domContentLoadedMs,
          loadMs,
          cumulativeLayoutShift: Math.round(cls * 1000) / 1000,
          longTaskCount: longTasks.length,
          longTasksMs: longTasks.slice(0, 10).map(t => Math.round(t.dur)),
        };

        if (opts.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }

        const rows: string[][] = [
          ['events', String(summary.eventCount)],
          ['FCP (ms)', summary.firstContentfulPaintMs?.toFixed(1) ?? '—'],
          ['LCP (ms)', summary.largestContentfulPaintMs?.toFixed(1) ?? '—'],
          ['DCL (ms)', summary.domContentLoadedMs?.toFixed(1) ?? '—'],
          ['load (ms)', summary.loadMs?.toFixed(1) ?? '—'],
          ['CLS', summary.cumulativeLayoutShift.toFixed(3)],
          ['long tasks (>50ms)', String(summary.longTaskCount)],
        ];
        console.log(formatTable(['METRIC', 'VALUE'], rows));
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  const memoryCmd = program
    .command('memory')
    .description('Take a heap snapshot; subcommands for analysis')
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

        const outPath = opts.out ?? `/tmp/tirno-heap-${Date.now()}.heapsnapshot`;
        fs.writeFileSync(outPath, chunks.join(''));
        success(`Heap snapshot: ${outPath} (open in Chrome DevTools Memory tab)`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  memoryCmd
    .command('load')
    .description('Load a heap snapshot file and print summary stats')
    .argument('<path>', '.heapsnapshot file')
    .option('--json', 'Output as JSON')
    .action((path: string, opts) => {
      try {
        const snap = readHeapSnapshot(path);
        const summary = {
          path,
          totalSizeBytes: snap.totalSize,
          totalSizeMb: Math.round((snap.totalSize / 1024 / 1024) * 100) / 100,
          nodeCount: snap.nodeCount,
          stringsCount: snap.strings.length,
          nodeFields: snap.meta.node_fields,
        };
        if (opts.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }
        const rows: string[][] = [
          ['total size', `${summary.totalSizeMb} MB (${summary.totalSizeBytes} bytes)`],
          ['nodes', String(summary.nodeCount)],
          ['strings', String(summary.stringsCount)],
          ['node fields', summary.nodeFields.join(', ')],
        ];
        console.log(formatTable(['METRIC', 'VALUE'], rows));
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  memoryCmd
    .command('details')
    .description('Aggregate heap snapshot by type — top classes by retained size')
    .argument('<path>', '.heapsnapshot file')
    .option('--page-size <n>', 'Rows per page', intArg, 30)
    .option('--page-idx <n>', '0-based page index', intArg, 0)
    .option('--json', 'Output as JSON')
    .action((path: string, opts) => {
      try {
        const snap = readHeapSnapshot(path);
        const buckets = aggregateHeapByType(snap);
        const start = opts.pageIdx * opts.pageSize;
        const slice = buckets.slice(start, start + opts.pageSize);
        if (opts.json) {
          console.log(JSON.stringify({
            page: opts.pageIdx,
            pageSize: opts.pageSize,
            total: buckets.length,
            buckets: slice,
          }, null, 2));
          return;
        }
        const rows = slice.map(b => [
          b.type,
          b.name || '—',
          String(b.count),
          `${(b.size / 1024).toFixed(1)} KB`,
        ]);
        console.log(formatTable(['TYPE', 'NAME', 'COUNT', 'SIZE'], rows));
        info(`page ${opts.pageIdx} of ${Math.ceil(buckets.length / opts.pageSize) - 1} — ${buckets.length} total buckets`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
