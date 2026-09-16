/**
 * `tirno journal` — 세션의 이야기를 읽는다 (#217).
 */
import { Command } from 'commander';
import chalk from 'chalk';
import * as store from '../core/session-store.js';
import * as journal from '../core/journal.js';
import * as recipes from '../core/recipe-store.js';
import { RECORDABLE, stripSession } from './recipe.js';
import { success, info, fail } from '../output/formatter.js';
import { NoActiveSession } from '../util/errors.js';

function parseSince(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error('--since takes 10m · 2h · 1d · 30s');
  const n = Number(m[1]);
  return n * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] ?? 'm'] ?? 60000);
}

export function registerJournalCommand(program: Command): void {
  program
    .command('journal')
    .description('What this session did, in order — every command with how it ended and what changed. `--as-recipe <name>` turns the successful action commands into a recipe')
    .option('-s, --session <name>', 'Session name')
    .option('--since <duration>', 'Only entries newer than this, e.g. 10m · 2h')
    .option('--last <n>', 'Only the last N entries', (v: string) => Number(v))
    .option('--failed', 'Only failures')
    .option('--as-recipe <name>', 'Save the successful action commands as a recipe with this name')
    .option('--clear', 'Delete this session\'s journal')
    .option('--json', 'JSON lines')
    .action((opts) => {
      try {
        const session = opts.session ?? store.getActive();
        if (!session) throw new NoActiveSession();
        if (opts.clear) { success(journal.clear(session) ? `cleared journal of ${session}` : `no journal for ${session}`); return; }
        let entries = journal.read(session, { sinceMs: opts.since ? parseSince(opts.since) : undefined, last: opts.last });
        if (opts.failed) entries = entries.filter(e => !e.ok);

        if (opts.asRecipe) {
          const steps = entries.filter(e => e.ok && RECORDABLE.has(e.cmd)).map(e => {
            const argv = stripSession(e.argv);
            return { argv, at: e.t };
          });
          if (!steps.length) throw new Error('no successful action commands in this range — nothing to save');
          const refs = steps.filter(s => s.argv.some(a => /^@\d/.test(a)));
          if (refs.length) info(`${refs.length} step(s) use @N refs — they will not resolve on replay; edit them to role + name`);
          let url = '';
          try { url = entries.find(e => e.cmd === 'nav' && e.ok)?.argv.find(a => /^https?:|^file:/.test(a)) ?? ''; } catch { /* ok */ }
          const r: recipes.Recipe = { schemaVersion: recipes.RECIPE_SCHEMA_VERSION, name: opts.asRecipe, domain: recipes.domainOf(url), ...(url ? { startUrl: url } : {}), vars: [], steps, recordedAt: new Date().toISOString(), runs: { ok: 0, failed: 0 } };
          const p = recipes.save(r);
          success(`saved recipe "${r.name}" (${steps.length} steps) from the journal → ${p}`);
          return;
        }

        if (opts.json) { for (const e of entries) console.log(JSON.stringify(e)); return; }
        if (!entries.length) { info(`journal of ${session} is empty${opts.since ? ` in the last ${opts.since}` : ''}`); return; }
        for (const e of entries) {
          const time = e.t.slice(11, 19);
          const mark = e.ok ? chalk.green('✓') : chalk.red('✗');
          const argv = stripSession(e.argv).join(' ');
          const d = e.delta;
          const deltaText = d ? [d.url ? `url → ${short(d.url.to)}` : '', d.added || d.removed ? `+${d.added ?? 0} −${d.removed ?? 0}` : '', d.focus ? 'focus moved' : '', d.consoleErrors ? `${d.consoleErrors} console error(s)` : ''].filter(Boolean).join(' · ') : '';
          console.log(`${chalk.dim(time)} ${mark} ${argv.padEnd(44).slice(0, 44)} ${chalk.dim(`${e.ms}ms`)}${e.summary ? `  ${e.ok ? chalk.dim(e.summary) : chalk.red(e.summary)}` : ''}${deltaText ? chalk.dim(`  [${deltaText}]`) : ''}${e.code ? chalk.dim(`  code:${e.code}`) : ''}`);
        }
        info(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — \`tirno journal --as-recipe <name>\` turns the successful actions into a recipe`);
      } catch (e) {
        fail(e);
      }
    });
}

function short(url: string): string {
  try { const u = new URL(url); return u.host + u.pathname; } catch { return url; }
}
