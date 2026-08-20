import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import * as recStore from '../core/record-store.js';
import * as store from '../core/session-store.js';
import { formatTable, success, info, error } from '../output/formatter.js';

interface ClientRecState {
  events: recStore.RecordedEvent[];
  recording: boolean;
  startTs: number;
}

export function registerRecordCommands(program: Command): void {
  const rec = program
    .command('record')
    .description('Record user input events for later replay');

  rec
    .command('start')
    .description('Begin recording; events are collected on the page side and persisted in localStorage so SPA route changes / page reloads survive')
    .option('-s, --session <name>', 'Session name')
    .action(async (opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);
        await page.evaluate(() => {
          const w = window as unknown as { __tirno_rec: ClientRecState; __tirno_rec_flush?: () => void };
          if (!w.__tirno_rec) throw new Error('record install missing — reconnect session');
          w.__tirno_rec.events = [];
          w.__tirno_rec.startTs = Date.now();
          w.__tirno_rec.recording = true;
          // sync persist immediately so a reload before any event still finds recording=true
          if (w.__tirno_rec_flush) w.__tirno_rec_flush();
        });
        const url = page.url();
        browser.disconnect();
        // Remember where this began. The page-side buffer cannot tell us later:
        // it is per-origin localStorage, so a flow that navigates leaves it behind.
        store.update(meta.name, { recording: { startUrl: url, startedAt: new Date().toISOString() } });
        success(`Recording on ${url} — interact with the page, then "tirno record stop"`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  rec
    .command('stop')
    .description('Stop recording; print captured events')
    .option('-s, --session <name>', 'Session name')
    .option('--save <name>', 'Save under name (~/.tirno/recordings/<name>.json)')
    .option('--json', 'Print events as raw JSON instead of summary')
    .action(async (opts) => {
      try {
        const { browser, meta } = await connect(opts.session);
        const page = await getActivePage(browser);
        const result = await page.evaluate(() => {
          const w = window as unknown as { __tirno_rec: ClientRecState; __tirno_rec_flush?: () => void };
          if (!w.__tirno_rec) return null;
          w.__tirno_rec.recording = false;
          const events = w.__tirno_rec.events.slice();
          // clear in-memory + localStorage so the next start is clean
          w.__tirno_rec.events = [];
          w.__tirno_rec.startTs = 0;
          if (w.__tirno_rec_flush) w.__tirno_rec_flush();
          try { localStorage.removeItem('__tirno_rec_state'); } catch { /* ignore */ }
          return {
            events,
            durationMs: events.length > 0 ? events[events.length - 1].t : 0,
          };
        });
        const url = page.url();
        browser.disconnect();

        if (!result) throw new Error('No recording state on page');

        // Where the recording began, not where it ended — replay navigates to
        // this before replaying, and a flow that moved would otherwise start on
        // its own last page.
        const startUrl = meta.recording?.startUrl ?? url;
        store.update(meta.name, { recording: undefined });

        // The recorder's buffer is per-origin localStorage. Cross an origin and
        // it is left behind on the old one, so stop finds a clean slate and has
        // nothing to report. Say that out loud — "0 events" on its own reads as
        // "you did not touch anything".
        if (result.events.length === 0) {
          const origin = (u: string) => { try { return new URL(u).origin; } catch { return u; } };
          if (origin(startUrl) !== origin(url)) {
            info(`Recording started on ${origin(startUrl)} and ended on ${origin(url)} — events are buffered per origin, so anything before the jump was lost.`);
          } else {
            info('No events were captured — was anything actually interacted with?');
          }
        }

        if (opts.save) {
          recStore.save({
            name: opts.save,
            capturedAt: new Date().toISOString(),
            durationMs: result.durationMs,
            startUrl,
            events: result.events,
          });
          success(`Saved "${opts.save}" — ${result.events.length} events, ${result.durationMs}ms`);
        }

        if (opts.json) {
          console.log(JSON.stringify(result.events, null, 2));
        } else {
          info(`${result.events.length} events captured (${result.durationMs}ms)`);
          for (const e of result.events.slice(0, 50)) {
            const sel = e.sel ? ` ${e.sel}` : '';
            const xy = e.x !== undefined ? ` (${e.x},${e.y})` : '';
            const extra = e.key ? ` key=${e.key}` : (e.value ? ` value="${(e.value || '').slice(0, 30)}"` : '');
            console.log(`+${e.t.toString().padStart(5)}ms  ${e.type.padEnd(8)}${xy}${sel}${extra}`);
          }
          if (result.events.length > 50) info(`... ${result.events.length - 50} more (use --json for full)`);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  rec
    .command('list')
    .description('List saved recordings')
    .action(() => {
      try {
        const all = recStore.list();
        if (all.length === 0) { info('No recordings'); return; }
        console.log(formatTable(['NAME', 'EVENTS', 'DURATION', 'CAPTURED', 'URL'],
          all.map(r => [
            r.name,
            String(r.events.length),
            `${r.durationMs}ms`,
            r.capturedAt.replace('T', ' ').slice(0, 19),
            r.startUrl.length > 50 ? r.startUrl.slice(0, 47) + '...' : r.startUrl,
          ])
        ));
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });

  rec
    .command('rm <name>')
    .description('Delete a saved recording')
    .action((name) => {
      try {
        recStore.remove(name);
        success(`Removed "${name}"`);
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
