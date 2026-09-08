// Raw CDP passthrough. The whole point of tirno is to be a thin shell over
// CDP — wrappers (click/fill/nav) are convenience only. For anything CDP
// can do, this command should be the immediate escape hatch so we don't
// have to ship a new wrapper for each new domain (drag intercept, target
// attach, network mocking, accessibility queries, etc).
//
// 한 번의 호출은 한 번의 연결이다. 그래서 **호출 사이에 유지돼야 의미가 있는 CDP
// 상태**가 전부 무효가 된다 — `objectId` 는 다음 호출에서 "Could not find object
// with given id" 가 되고, `objectGroup` 도 함께 사라진다. `--script` 는 그 자리다:
// 여러 명령을 한 연결 위에서 순서대로 보내고, 앞 결과를 뒤에서 참조한다 (#154).

import { Command } from 'commander';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { resolveExpression } from './eval.js';
import { info, error } from '../output/formatter.js';

export interface ScriptStep {
  method: string;
  params: Record<string, unknown>;
}

/** 실행된 한 단계. `error` 가 있으면 거기서 멈춘 것이다. */
export interface StepResult {
  step: number;
  method: string;
  result?: unknown;
  error?: string;
}

/**
 * 스크립트는 `{method, params?}` 의 배열이다.
 *
 * 형태를 여기서 전부 거절하는 이유는, 절반쯤 보내다 멈추면 그때까지의 부작용은
 * 남고 되돌릴 방법이 없기 때문이다 — 보내기 전에 갈라야 한다.
 */
export function parseScript(source: string): ScriptStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (e) {
    throw new Error(`--script is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--script must be a JSON array of {method, params} steps.');
  }
  if (!parsed.length) throw new Error('--script is an empty array — nothing to send.');

  return parsed.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`--script step ${i} is not an object.`);
    }
    const step = raw as Record<string, unknown>;
    if (typeof step.method !== 'string' || !step.method) {
      throw new Error(`--script step ${i} has no "method".`);
    }
    if (step.params !== undefined
        && (typeof step.params !== 'object' || step.params === null || Array.isArray(step.params))) {
      throw new Error(`--script step ${i} ("${step.method}") has a "params" that is not an object.`);
    }
    return { method: step.method, params: (step.params ?? {}) as Record<string, unknown> };
  });
}

// `"$0.result.objectId"` — 앞 단계의 결과를 가리킨다.
//
// **문자열 전체가 참조일 때만** 바꾼다. 문자열 안에 끼워 넣는 형태까지 받으면
// `"$"` 가 들어간 평범한 값(정규식·셸 조각·jQuery 표현식)이 조용히 뜻이 달라진다.
// objectId 를 넘기는 것이 이 기능의 용건이고, 그건 전부 통짜 문자열이다.
const REF = /^\$(\d+)((?:\.[A-Za-z0-9_$-]+)*)$/;

/**
 * params 안의 `$N.경로` 를 앞 단계의 결과로 바꾼다.
 *
 * 값의 타입은 보존한다 — 숫자 결과를 참조하면 숫자가 들어간다. 문자열로 굳히면
 * `nodeId` 같은 자리에서 CDP 가 조용히 거절한다.
 */
export function resolveRefs<T>(params: T, results: unknown[], stepIndex: number): T {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const m = REF.exec(value);
      if (!m) return value;

      const target = Number(m[1]);
      if (target >= stepIndex) {
        throw new Error(
          `step ${stepIndex} refers to "${value}", but step ${target} `
          + `${target === stepIndex ? 'is itself' : 'has not run yet'} — a step can only read steps before it.`,
        );
      }

      let cur: unknown = results[target];
      const path = m[2] ? m[2].slice(1).split('.') : [];
      for (const [i, key] of path.entries()) {
        if (cur === null || cur === undefined || typeof cur !== 'object') {
          throw new Error(
            `step ${stepIndex} refers to "${value}", but step ${target} has no `
            + `"${path.slice(0, i + 1).join('.')}" (got ${cur === undefined ? 'undefined' : JSON.stringify(cur)}).`,
          );
        }
        cur = (cur as Record<string, unknown>)[key];
      }
      if (cur === undefined) {
        throw new Error(`step ${stepIndex} refers to "${value}", but that is undefined in step ${target}'s result.`);
      }
      return cur;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(params) as T;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

export function registerCdpCommands(program: Command): void {
  program
    .command('cdp [method] [params]')
    .description('Send a raw CDP command. method e.g. Input.dispatchDragEvent. params is JSON. --script sends several over one connection so objectIds survive between them.')
    .option('-s, --session <name>', 'Session name')
    .option('--browser', 'Send on browser-level CDP session (Target.*, Browser.*) instead of page')
    .option('--listen <event>', 'Listen for the given CDP event for --listen-ms before sending; emits captured payloads')
    .option('--listen-ms <n>', 'Milliseconds to listen for events (default 1000)', (v) => parseInt(v, 10), 1000)
    .option('--script [file]', 'Send a JSON array of {method, params} over ONE CDP session, in order. A later step reads an earlier result with "$0.result.objectId". Omit the path or pass "-" to read the script from stdin.')
    .addHelpText('after', SCRIPT_HELP)
    .action(async (method: string | undefined, params: string | undefined, opts) => {
      try {
        if (opts.script !== undefined) {
          if (method !== undefined) {
            throw new Error('Pass either <method> or --script, not both. A --script step carries its own method.');
          }
          if (opts.listen) {
            throw new Error('--listen does not combine with --script: there is no single command to attribute the events to.');
          }
          await runScript(opts);
          return;
        }
        if (method === undefined) {
          throw new Error('Provide <method>, or --script <file> for several commands over one connection.');
        }

        const parsed = params ? JSON.parse(params) : {};

        const { browser } = await connect(opts.session);
        const page = await getActivePage(browser);
        const cdp = opts.browser
          ? await browser.target().createCDPSession()
          : await page.createCDPSession();

        const captured: unknown[] = [];
        if (opts.listen) {
           
          (cdp as any).on(opts.listen, (e: unknown) => captured.push(e));
        }

         
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

/**
 * 한 연결 위에서 단계들을 순서대로 보낸다.
 *
 * 중간에 실패해도 **그때까지의 결과를 전부 낸다.** objectId 를 얻는 데 성공한 뒤
 * 그것을 쓰는 단계에서 실패하는 것이 흔한 모양인데, 여기서 결과를 버리면 무엇을
 * 얻었었는지조차 사라져 처음부터 다시 해야 한다.
 */
async function runScript(opts: {
  session?: string; browser?: boolean; script: string | boolean;
}): Promise<void> {
  const file = typeof opts.script === 'string' && opts.script !== '-' ? opts.script : undefined;
  const source = await resolveExpression(
    file === undefined ? '-' : undefined, file, readAllStdin, process.stdin.isTTY === true,
  );
  const steps = parseScript(source);

  const { browser } = await connect(opts.session);
  const page = await getActivePage(browser);
  const cdp = opts.browser
    ? await browser.target().createCDPSession()
    : await page.createCDPSession();

  const done: StepResult[] = [];
  const results: unknown[] = [];
  let failed = false;

  try {
    for (const [i, step] of steps.entries()) {
      let sent: Record<string, unknown>;
      try {
        sent = resolveRefs(step.params, results, i);
      } catch (e) {
        done.push({ step: i, method: step.method, error: (e as Error).message });
        failed = true;
        break;
      }
      try {
         
        const result = await ((cdp.send as any)(step.method, sent) as Promise<unknown>);
        results.push(result);
        done.push({ step: i, method: step.method, result });
      } catch (e) {
        done.push({ step: i, method: step.method, error: (e as Error).message });
        failed = true;
        break;
      }
    }
  } finally {
    await cdp.detach();
    browser.disconnect();
  }

  console.log(JSON.stringify(done, null, 2));
  if (failed) {
    const last = done[done.length - 1];
    error(`--script stopped at step ${last.step} (${last.method}); ${done.length - 1} step(s) before it ran.`);
    // `process.exit` 이 아니라 exitCode 다. 파이프로 나갈 때 stdout 은 비동기라
    // 즉시 종료하면 **버퍼에 남은 것이 잘린다** — 실측으로 131072 바이트에서
    // 끊겼다. 하필 이 자리는 "실패해도 그때까지의 결과는 낸다" 가 요점이라,
    // 자르면 고치려던 것을 그대로 다시 만든다.
    process.exitCode = 1;
  }
}

const SCRIPT_HELP = `
--script keeps ONE CDP session open for every step, which is the only way the
state that lives on a connection survives between commands:

  objectId      Runtime.evaluate hands one back; it is invalid the moment the
                connection closes. DOMDebugger.getEventListeners,
                Runtime.callFunctionOn, Runtime.getProperties and DOM.requestNode
                all take one, so none of them work across two "tirno cdp" calls.
  objectGroup   released with the connection.

A step reads an earlier step's result by index: "$0" is the whole result of step
0, "$0.result.objectId" walks into it. Only a string that is *entirely* a
reference is substituted, and the value keeps its type.

  cat > listeners.json <<'JSON'
  [
    { "method": "Runtime.evaluate",
      "params": { "expression": "document.querySelector('button')" } },
    { "method": "DOMDebugger.getEventListeners",
      "params": { "objectId": "$0.result.objectId", "depth": 1 } }
  ]
  JSON
  tirno cdp --script listeners.json

Every step that ran is printed even when a later one fails, so an objectId you
already paid for is not thrown away.
`;
