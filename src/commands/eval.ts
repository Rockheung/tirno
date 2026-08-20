import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { error } from '../output/formatter.js';

export function registerEvalCommand(program: Command): void {
  program
    .command('eval')
    .description('Evaluate JavaScript expression')
    .argument('<expression>', 'JavaScript expression')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Output as JSON')
    .action(async (expression: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        // Always wrapped, so a thrown expression is distinguishable from one that
        // returned. A bare `{ __error }` sentinel cannot be — a page is free to
        // return that shape — and it left the caller reading exit 0 either way.
        const outcome = await page.evaluate((expr) => {
          try {
            return { threw: false, value: eval(expr) };
          } catch (e) {
            return { threw: true, message: (e as Error).message };
          }
        }, expression) as { threw: boolean; value?: unknown; message?: string };

        browser.disconnect();

        if (outcome.threw) throw new Error(outcome.message ?? 'Expression threw');

        const result = outcome.value;
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (typeof result === 'object' && result !== null) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result);
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
