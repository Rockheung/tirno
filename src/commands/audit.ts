// `tirno audit` — Lighthouse audit against the active session.
//
// Reuses the running Chrome's --remote-debugging-port instead of spawning
// a fresh chrome (avoids re-login / cache loss). Categories default to
// accessibility / seo / best-practices / pwa; perf is opt-in because it
// requires a clean reload.

import { Command } from 'commander';
import fs from 'node:fs';
import * as store from '../core/session-store.js';
import { success, info, error } from '../output/formatter.js';

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('Run a Lighthouse audit against the active session (accessibility / seo / best-practices / perf)')
    .argument('[url]', 'URL to audit (defaults to active page URL)')
    .option('-s, --session <name>', 'Session name')
    .option('--mode <mode>', 'navigation | snapshot | timespan', 'navigation')
    .option('--device <device>', 'desktop | mobile', 'desktop')
    .option('--categories <list>', 'Comma-separated subset: accessibility,seo,best-practices,performance,pwa')
    .option('--out <path>', 'HTML report output path')
    .option('--json <path>', 'JSON LHR output path')
    .option('--quiet', "Don't print summary table — just write files")
    .action(async (urlArg: string | undefined, opts) => {
      try {
        const meta = opts.session ? store.get(opts.session) : (() => {
          const active = store.getActive();
          if (!active) throw new Error('No active session — pass --session or run `tirno attach`');
          return store.get(active);
        })();

        // Resolve URL: explicit arg → fall back to active page's location.
        let url: string;
        if (urlArg) {
          url = urlArg;
        } else {
          // Hit the chrome /json endpoint to read current URL — avoids opening
          // a puppeteer connection just to read href.
          const r = await fetch(`http://localhost:${meta.port}/json`).then(r => r.json() as Promise<Array<{ type: string; url: string }>>);
          const page = r.find(t => t.type === 'page' && !t.url.startsWith('chrome://'));
          if (!page) throw new Error('No page target — pass [url] explicitly');
          url = page.url;
        }

        const cats = opts.categories
          ? (opts.categories as string).split(',').map((s: string) => s.trim()).filter(Boolean)
          : ['accessibility', 'seo', 'best-practices'];

        const ts = Date.now();
        const htmlOut = opts.out ?? `/tmp/tirno-lh-${ts}.html`;
        const jsonOut = opts.json ?? `/tmp/tirno-lh-${ts}.json`;

        // Lighthouse supports navigation | snapshot | timespan.
        // Loose typing at the boundary — lighthouse's Flags type is huge and
        // changes between minor versions; we only need a narrow subset.
        const lhMod = await import('lighthouse');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lighthouse = lhMod.default as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const desktopConfig = lhMod.desktopConfig as any;

        const flags = {
          port: meta.port,
          output: ['html', 'json'] as ('html' | 'json')[],
          onlyCategories: cats,
        };
        const config = opts.device === 'desktop' ? desktopConfig : undefined;

        info(`Running Lighthouse (${opts.mode}, ${opts.device}) on ${url}…`);
        let result: unknown;
        if (opts.mode === 'snapshot') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result = await (lhMod.snapshot as any)({ url, flags, config });
        } else if (opts.mode === 'timespan') {
          throw new Error('timespan mode is split start/stop — not yet wired into tirno (use mode=navigation)');
        } else {
          result = await lighthouse(url, flags, config);
        }

        if (!result) throw new Error('Lighthouse returned no result');
        const lh = result as { lhr: LhrResult; report: string | string[] };
        const reports = Array.isArray(lh.report) ? lh.report : [lh.report];
        const [htmlReport, jsonReport] = reports;
        if (htmlReport) fs.writeFileSync(htmlOut, htmlReport);
        if (jsonReport) fs.writeFileSync(jsonOut, jsonReport);

        success(`Lighthouse done — html: ${htmlOut} json: ${jsonOut}`);

        if (!opts.quiet) {
          const lhr = lh.lhr;
          if (lhr?.categories) {
            console.log('');
            for (const [k, v] of Object.entries(lhr.categories)) {
              const cat = v as { title?: string; score: number | null };
              const score = cat.score === null ? '—' : `${Math.round(cat.score * 100)}`;
              console.log(`  ${(cat.title ?? k).padEnd(20)} ${score.padStart(5)}`);
            }
          }
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}

interface LhrResult {
  categories?: Record<string, { title?: string; score: number | null }>;
}
