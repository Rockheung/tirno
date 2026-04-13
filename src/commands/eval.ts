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

        const result = await page.evaluate((expr) => {
          try {
            return eval(expr);
          } catch (e) {
            return { __error: (e as Error).message };
          }
        }, expression);

        browser.disconnect();

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
