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

export type EventKind =
  | 'cache.hit'
  | 'cache.miss'
  | 'cache.save'
  | 'embedding.compute'
  | 'llm.call'
  | 'llm.retry'
  | 'llm.fail'
  | 'trail.replay'
  | 'trail.save'
  | 'explore.start'
  | 'explore.end';

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
  cacheHitRate: number | null;
  llmCostUsd: number;
  llmCallCount: number;
  llmRetryCount: number;
  llmFailCount: number;
  exploreCount: number;
  exploreOutcomes: Record<string, number>;
  trailReplayCount: number;
  trailReplaySuccessRate: number | null;
  embeddingComputeCount: number;
  avgLatencyMs: Record<string, number>;
  windowStart: string | null;
  windowEnd: string | null;
}

export function aggregate(events: MetricEvent[]): Aggregate {
  const totals: Record<string, number> = {};
  let cacheHits = 0, cacheMisses = 0;
  let llmCost = 0, llmCalls = 0, llmRetries = 0, llmFails = 0;
  let exploreCount = 0;
  const exploreOutcomes: Record<string, number> = {};
  let trailReplays = 0, trailReplaySuccess = 0;
  let embeddings = 0;
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
    if (e.kind === 'cache.hit') cacheHits++;
    else if (e.kind === 'cache.miss') cacheMisses++;
    else if (e.kind === 'llm.call') {
      llmCalls++;
      if (typeof e.costUsd === 'number') llmCost += e.costUsd;
    } else if (e.kind === 'llm.retry') llmRetries++;
    else if (e.kind === 'llm.fail') llmFails++;
    else if (e.kind === 'explore.end') {
      exploreCount++;
      const o = String(e.outcome ?? 'unknown');
      exploreOutcomes[o] = (exploreOutcomes[o] ?? 0) + 1;
    } else if (e.kind === 'trail.replay') {
      trailReplays++;
      if (e.success === true) trailReplaySuccess++;
    } else if (e.kind === 'embedding.compute') {
      embeddings++;
    }
  }

  const cacheTotal = cacheHits + cacheMisses;
  const avgLatencyMs: Record<string, number> = {};
  for (const [k, b] of Object.entries(latencyByKind)) {
    avgLatencyMs[k] = b.n > 0 ? Math.round(b.sum / b.n) : 0;
  }

  return {
    totals,
    cacheHitRate: cacheTotal > 0 ? cacheHits / cacheTotal : null,
    llmCostUsd: Math.round(llmCost * 10000) / 10000,
    llmCallCount: llmCalls,
    llmRetryCount: llmRetries,
    llmFailCount: llmFails,
    exploreCount,
    exploreOutcomes,
    trailReplayCount: trailReplays,
    trailReplaySuccessRate: trailReplays > 0 ? trailReplaySuccess / trailReplays : null,
    embeddingComputeCount: embeddings,
    avgLatencyMs,
    windowStart: firstTs,
    windowEnd: lastTs,
  };
}
