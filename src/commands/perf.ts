import { Command } from 'commander';
import { floatArg, intArg } from '../util/parsers.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';

import { success, info, error } from '../output/formatter.js';
import { formatTable } from '../output/formatter.js';

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
