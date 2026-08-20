import { Command } from 'commander';
import * as visualCache from '../core/visual-cache.js';
import { formatTable, info, success, error } from '../output/formatter.js';

export function registerCacheCommands(program: Command): void {
  const cache = program
    .command('cache')
    .description('Visual cache: URL-keyed snapshot store');

  cache
    .command('list')
    .description('List cached entries')
    .option('--domain <d>', 'Filter by domain')
    .option('--limit <n>', 'Max entries', parseInt, 50)
    .action((opts) => {
      try {
        const entries = visualCache.list({ domain: opts.domain, limit: opts.limit });
        if (entries.length === 0) {
          info('No cache entries');
          return;
        }
        const rows = entries.map(e => [
          e.domain,
          e.urlPath.length > 50 ? e.urlPath.slice(0, 47) + '...' : e.urlPath,
          String(e.refs.length),
          e.visualFp.slice(0, 8),
          e.capturedAt.replace('T', ' ').slice(0, 19),
        ]);
        console.log(formatTable(['DOMAIN', 'PATH', 'REFS', 'FP', 'CAPTURED'], rows));
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  cache
    .command('load <url>')
    .description('Emit cached snapshot for a URL')
    .option('--mode <m>', 'Match mode: exact | urlPath', 'urlPath')
    .action((url, opts) => {
      try {
        const entry = visualCache.lookup(url, opts.mode);
        if (!entry) {
          info(`No cached entry for ${url} (mode: ${opts.mode})`);
          process.exit(1);
        }
        console.log(`# cached at ${entry.capturedAt}`);
        console.log(`# url: ${entry.url}`);
        console.log(`# fp: ${entry.visualFp}  viewport: ${entry.viewport ? `${entry.viewport.w}x${entry.viewport.h}@${entry.viewport.dpr}` : '?'}`);
        console.log('');
        for (const r of entry.refs) {
          const sel = r.selector ? ` [${r.selector}]` : '';
          const bbox = r.bbox ? ` (${r.bbox.x},${r.bbox.y} ${r.bbox.w}x${r.bbox.h})` : '';
          const name = r.name ? ` "${r.name}"` : '';
          console.log(`${r.refId.padEnd(5)} ${r.role}${name}${sel}${bbox}`);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  cache
    .command('prune')
    .description('Remove old cache entries')
    .option('--older-than <days>', 'Remove entries older than N days', parseInt)
    .option('--domain <d>', 'Limit to domain')
    .action((opts) => {
      try {
        const { removed } = visualCache.prune({
          olderThanDays: opts.olderThan,
          domain: opts.domain,
        });
        success(`Removed ${removed} entries`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
