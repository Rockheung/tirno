// Raw CDP passthrough. The whole point of tirno is to be a thin shell over
// CDP — wrappers (click/fill/nav) are convenience only. For anything CDP
// can do, this command should be the immediate escape hatch so we don't
// have to ship a new wrapper for each new domain (drag intercept, target
// attach, network mocking, accessibility queries, etc).

import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, info, error } from '../output/formatter.js';

export function registerCdpCommands(program: Command): void {
  program
    .command('cdp <method> [params]')
    .description('Send a raw CDP command. method e.g. Input.dispatchDragEvent. params is JSON.')
    .option('-s, --session <name>', 'Session name')
    .option('--browser', 'Send on browser-level CDP session (Target.*, Browser.*) instead of page')
    .option('--listen <event>', 'Listen for the given CDP event for --listen-ms before sending; emits captured payloads')
    .option('--listen-ms <n>', 'Milliseconds to listen for events (default 1000)', (v) => parseInt(v, 10), 1000)
    .action(async (method: string, params: string | undefined, opts) => {
      try {
        const parsed = params ? JSON.parse(params) : {};

        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const cdp = opts.browser
          ? await browser.target().createCDPSession()
          : await page.createCDPSession();

        const captured: unknown[] = [];
        if (opts.listen) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (cdp as any).on(opts.listen, (e: unknown) => captured.push(e));
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await ((cdp.send as any)(method, parsed) as Promise<unknown>);

        if (opts.listen) {
          await new Promise(r => setTimeout(r, opts.listenMs));
        }

        await cdp.detach();
        browser.disconnect();

        if (opts.listen) {
          info(`captured ${captured.length} ${opts.listen} events`);
          console.log(JSON.stringify({ result, events: captured }, null, 2));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
