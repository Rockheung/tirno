// Lightweight metrics + structured event log.
//
// Every operation worth observing emits one JSONL line to
// ~/.tirno/metrics.jsonl. `tirno stats` aggregates.
//
// Disabled if TIRNO_METRICS=0 (opt-out for sensitive environments). Logs are
// local-only — never sent anywhere.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// `trail.replay` is the only event anything emits. Kinds are not declared
// ahead of a caller — cache.* and trail.save sat here for months describing
// events no code ever wrote, which made `tirno stats` print a cache hit rate
// computed from zero samples.
//
// Read-side stays permissive: a log written before the LLM layer was removed
// still carries llm.* / explore.* / embedding.compute lines, and aggregate()
// must not choke on them — unknown kinds fall through to `totals`.
export type EventKind = 'trail.replay';

export interface MetricEvent {
  ts: string;          // ISO timestamp
  kind: EventKind;
  ms?: number;         // duration if applicable
  // payload keys are kind-specific; kept loose for forward compatibility
  [key: string]: unknown;
}

function metricsFile(): string {
  return process.env.TIRNO_METRICS_FILE ?? path.join(os.homedir(), '.tirno', 'metrics.jsonl');
}

function enabled(): boolean {
  return process.env.TIRNO_METRICS !== '0';
}

let writeStream: fs.WriteStream | null = null;
function getStream(): fs.WriteStream | null {
  if (!enabled()) return null;
  if (writeStream && !writeStream.closed) return writeStream;
  const f = metricsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeStream = fs.createWriteStream(f, { flags: 'a' });
  return writeStream;
}

export function emit(kind: EventKind, payload: Record<string, unknown> = {}): void {
  const s = getStream();
  if (!s) return;
  const event: MetricEvent = { ts: new Date().toISOString(), kind, ...payload };
  s.write(JSON.stringify(event) + '\n');
}

/** Read all events. Linear scan; for huge logs use tail/stats by date range. */
export function readAll(): MetricEvent[] {
  const f = metricsFile();
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean);
  const out: MetricEvent[] = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

export interface Aggregate {
  totals: Record<string, number>;
  trailReplayCount: number;
  trailReplaySuccessRate: number | null;
  avgLatencyMs: Record<string, number>;
  windowStart: string | null;
  windowEnd: string | null;
}

export function aggregate(events: MetricEvent[]): Aggregate {
  const totals: Record<string, number> = {};
  let trailReplays = 0, trailReplaySuccess = 0;
  const latencyByKind: Record<string, { sum: number; n: number }> = {};
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const e of events) {
    totals[e.kind] = (totals[e.kind] ?? 0) + 1;
    if (firstTs === null || e.ts < firstTs) firstTs = e.ts;
    if (lastTs === null || e.ts > lastTs) lastTs = e.ts;
    if (typeof e.ms === 'number') {
      const b = latencyByKind[e.kind] ?? { sum: 0, n: 0 };
      b.sum += e.ms;
      b.n += 1;
      latencyByKind[e.kind] = b;
    }
    if (e.kind === 'trail.replay') {
      trailReplays++;
      if (e.success === true) trailReplaySuccess++;
    }
  }

  const avgLatencyMs: Record<string, number> = {};
  for (const [k, b] of Object.entries(latencyByKind)) {
    avgLatencyMs[k] = b.n > 0 ? Math.round(b.sum / b.n) : 0;
  }

  return {
    totals,
    trailReplayCount: trailReplays,
    trailReplaySuccessRate: trailReplays > 0 ? trailReplaySuccess / trailReplays : null,
    avgLatencyMs,
    windowStart: firstTs,
    windowEnd: lastTs,
  };
}
