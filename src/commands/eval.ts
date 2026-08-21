import { Command } from 'commander';
import { intArg } from '../util/parsers.js';
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
    .option('--timeout <ms>', 'Give up when the expression has not settled. 0 waits as long as the CDP connection allows (~3 min).', intArg, 30000)
    .action(async (expression: string, opts) => {
      try {
        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);

        // Always wrapped, so a thrown expression is distinguishable from one that
        // returned. A bare `{ __error }` sentinel cannot be — a page is free to
        // return that shape — and it left the caller reading exit 0 either way.
        //
        // The callback is async and the expression is awaited: puppeteer only
        // awaits a promise it gets at the top level, so `{ value: <promise> }`
        // would serialize to `{}` and every async expression would lose its
        // result. Rejections land in the same catch as synchronous throws.
        const evaluation = page.evaluate(async (expr) => {
          try {
            return { threw: false, value: await eval(expr) };
          } catch (e) {
            return { threw: true, message: (e as Error).message };
          }
        }, expression) as Promise<{ threw: boolean; value?: unknown; message?: string }>;

        // 페이지가 절대 settle 하지 않는 promise 를 돌려줄 수 있고, 그러면 이 명령은
        // 끝나지 않는다. `navigator.clipboard.readText()` 가 권한 없이 그렇게 되고,
        // 밖에서 죽이면 종료 코드만 남아 원인을 하나도 알려주지 않는다.
        //
        // 페이지 쪽 실행을 멈추지는 않는다 — 멈출 수 있어도 그것은 관측이 아니라
        // 개입이다. 기다리기를 그만두고, 무엇이 일어났는지 말하고 나온다.
        const outcome = opts.timeout > 0
          ? await Promise.race([
              evaluation,
              new Promise<never>((_, reject) => setTimeout(
                () => reject(new Error(`Expression has not settled after ${opts.timeout}ms — it is still pending in the page. Raise --timeout, or pass --timeout 0 to wait.`)),
                opts.timeout).unref()),
            ])
          : await evaluation;

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
