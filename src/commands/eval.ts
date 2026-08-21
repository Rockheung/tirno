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
        // 함수 리터럴은 호출한다. 안 부르면 함수 객체가 값이 되고, 직렬화되면서
        // `{}` 로 나온다 — 그것은 "함수를 안 불렀다" 가 아니라 "빈 결과" 로 읽힌다.
        // 여러 문장이 필요한 조작은 자연스럽게 함수로 감싸게 되므로 흔한 자리다.
        //
        // 인자를 받는 함수는 부르지 않는다. undefined 를 밀어 넣으면 그쪽이 더
        // 조용한 오답이 된다 — 무엇을 넘길지는 부르는 쪽만 안다.
        const evaluation = page.evaluate(async (expr) => {
          const describe = (fn: (...a: unknown[]) => unknown) =>
            ({ threw: false, fnArity: fn.length, fnName: fn.name || '(anonymous)' });
          try {
            const v = await eval(expr);
            if (typeof v === 'function') {
              if (v.length > 0) return describe(v);
              const called = await v();
              // 호출 결과가 또 함수면 거기서 멈춘다. 몇 겹인지는 부르는 쪽이 안다.
              if (typeof called === 'function') return { ...describe(called), afterCall: true };
              return { threw: false, value: called };
            }
            return { threw: false, value: v };
          } catch (e) {
            return { threw: true, message: (e as Error).message };
          }
        }, expression) as Promise<{
          threw: boolean; value?: unknown; message?: string;
          fnArity?: number; fnName?: string; afterCall?: boolean;
        }>;

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

        if (outcome.fnArity !== undefined) {
          throw new Error(outcome.afterCall
            ? `Calling it returned another function ${outcome.fnName} — nothing was serialised. Call through: (…)()()`
            : `Expression is a function ${outcome.fnName} taking ${outcome.fnArity} argument(s), so it was not called — pass them yourself: (…)(arg)`);
        }

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
