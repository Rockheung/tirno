// tirno stats — aggregate from ~/.tirno/metrics.jsonl

import { Command } from 'commander';
import { readAll, aggregate } from '../core/metrics.js';
import { formatTable, info, error } from '../output/formatter.js';

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Aggregate from local metrics log (~/.tirno/metrics.jsonl)')
    .option('--json', 'Output JSON')
    .option('--since <iso>', 'Only events at/after this ISO timestamp')
    .action((opts) => {
      try {
        let events = readAll();
        if (opts.since) {
          events = events.filter(e => e.ts >= opts.since);
        }
        const agg = aggregate(events);

        if (opts.json) {
          console.log(JSON.stringify(agg, null, 2));
          return;
        }

        if (events.length === 0) {
          info('No metrics events. Run some tirno commands first (or check TIRNO_METRICS=0).');
          return;
        }

        console.log(`# events: ${events.length}`);
        console.log(`# window: ${agg.windowStart} → ${agg.windowEnd}`);
        console.log('');

        // top-level summary
        const summary: Array<[string, string]> = [];
        if (agg.cacheHitRate !== null) {
          summary.push(['cache hit rate', `${(agg.cacheHitRate * 100).toFixed(1)}%`]);
        }
        if (agg.llmCallCount > 0) {
          summary.push(['LLM calls', String(agg.llmCallCount)]);
          summary.push(['LLM cost', `$${agg.llmCostUsd.toFixed(4)}`]);
          summary.push(['LLM retries', String(agg.llmRetryCount)]);
          summary.push(['LLM fails', String(agg.llmFailCount)]);
        }
        if (agg.exploreCount > 0) {
          summary.push(['explore runs', String(agg.exploreCount)]);
          for (const [outcome, n] of Object.entries(agg.exploreOutcomes)) {
            summary.push([`  outcome: ${outcome}`, String(n)]);
          }
        }
        if (agg.trailReplayCount > 0) {
          const rate = agg.trailReplaySuccessRate;
          summary.push(['trail replays', String(agg.trailReplayCount)]);
          summary.push(['trail replay success', rate !== null ? `${(rate * 100).toFixed(1)}%` : '-']);
        }
        if (agg.embeddingComputeCount > 0) {
          summary.push(['embeddings computed', String(agg.embeddingComputeCount)]);
        }

        if (summary.length > 0) {
          console.log(formatTable(['METRIC', 'VALUE'], summary));
          console.log('');
        }

        // per-kind totals
        const totalRows = Object.entries(agg.totals)
          .sort(([, a], [, b]) => b - a)
          .map(([k, n]) => [k, String(n), agg.avgLatencyMs[k] ? `${agg.avgLatencyMs[k]}ms avg` : '-']);
        console.log(formatTable(['EVENT', 'COUNT', 'LATENCY'], totalRows));
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
