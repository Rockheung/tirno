/**
 * `tirno recipe` — 절차를 기록하고 재생한다 (#211).
 *
 * `recipe begin login --var EMAIL --var PASSWORD` 뒤로 이 세션에서 친 행동 명령이 그대로
 * 적힌다(main.ts 의 postAction 훅 — 성공한 것만). `recipe end` 가 파일로 굳힌다.
 * `recipe run login EMAIL=… PASSWORD=…` 가 단계를 하나씩 tirno 자신으로 다시 친다 — 사용자가
 * 쳤던 그 argv 다. 실패하면 그 단계에서 멈추고 무엇이 달랐는지(그 명령의 실패 문구와
 * code)를 낸다. 에이전트는 그 지점만 다시 판단한다.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import * as store from '../core/session-store.js';
import * as recipes from '../core/recipe-store.js';
import * as refStore from '../core/ref-store.js';
import { connect } from '../core/chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import { success, info, warn, fail, formatTable } from '../output/formatter.js';
import { TirnoError } from '../util/errors.js';
import { NoActiveSession } from '../util/errors.js';
import { runStep, masker } from '../core/step-runner.js';

/** 기록되는 명령 — 페이지를 움직이거나 상태를 선언하는 것들 */
export const RECORDABLE = new Set([
  'click', 'fill', 'type', 'press', 'hover', 'scroll', 'upload', 'drag', 'select',
  'nav', 'back', 'forward', 'reload', 'wait', 'wait-for', 'ensure', 'expect',
]);

/** `-s x` · `--session x` · `--session=x` 를 뺀 argv — 재생 때 세션은 그때 것이다 */
export function stripSession(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-s' || a === '--session') { i++; continue; }
    if (a.startsWith('--session=')) continue;
    out.push(a);
  }
  return out;
}

/**
 * `@N` 은 그 스냅샷 세대에서만 뜻이 있다 — 다음 실행에서는 다른 요소거나 없다. 기록할 때
 * ref store 가 아는 role·name 으로 바꿔 적는다(`click @7` → `click button "Sign in"`).
 * 이름이 없는 것은 바꿀 수 없어 그대로 두고 경고한다.
 */
export function derefArgv(argv: string[], refs: refStore.RefStore): { argv: string[]; from?: string; warning?: string } {
  const i = argv.findIndex(a => refStore.isRef(a));
  if (i === -1) return { argv };
  const parsed = refStore.parseRef(argv[i]);
  const stored = parsed ? refs.refs[parsed.ref] : undefined;
  if (!stored) return { argv, warning: `${argv[i]} is not in the ref store — recorded as-is; it will not resolve on replay` };
  if (!stored.name) return { argv, warning: `${argv[i]} (${stored.role}) has no accessible name — recorded as-is; give it a name or use a selector` };
  const roleWord = stored.role === 'StaticText' ? 'text' : stored.role.toLowerCase();
  return { argv: [...argv.slice(0, i), roleWord, stored.name, ...argv.slice(i + 1)], from: argv[i] };
}

/** postAction 훅이 부른다 — 이 세션이 기록 중이면 한 줄 적는다 */
export function recordIfRecording(commandName: string, rawArgv: string[], sessionName: string | null | undefined): void {
  if (!RECORDABLE.has(commandName)) return;
  const name = sessionName ?? store.getActive();
  if (!name) return;
  let meta: store.SessionMetadata;
  try { meta = store.get(name); } catch { return; }
  const rec = meta.recipeRecording;
  if (!rec) return;
  const cleaned = recipes.maskVars(stripSession(rawArgv), rec.vars);
  const { argv, from, warning } = derefArgv(cleaned, refStore.load(name));
  if (warning) warn(`recipe: ${warning}`);
  rec.steps.push({ argv, at: new Date().toISOString(), ...(from ? { from } : {}) });
  store.update(name, { recipeRecording: rec });
  info(chalk.dim(`recipe ${rec.name}: step ${rec.steps.length} — ${argv.join(' ')}`));
}

function sessionOf(opts: { session?: string }): string {
  const name = opts.session ?? store.getActive();
  if (!name) throw new NoActiveSession();
  return name;
}

export function registerRecipeCommands(program: Command): void {
  const recipe = program
    .command('recipe')
    .description('Remember a procedure and replay it — the second visit costs no reasoning. `begin` records the action commands you run in this session, `end` saves them, `run` replays them step by step and stops at the first step whose outcome differs');

  recipe
    .command('begin')
    .description('Start recording this session\'s action commands (click · fill · type · press · nav · ensure · expect · wait-for …). @N targets are rewritten to role + name so they resolve next time')
    .argument('<name>', 'Recipe name, e.g. login')
    .option('-s, --session <name>', 'Session name')
    .option('--var <NAME>', 'Environment variable whose value must never be written down: any argument equal to $NAME\'s value is recorded as "$NAME" (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .action(async (name: string, opts) => {
      try {
        const session = sessionOf(opts);
        const meta = store.get(session);
        if (meta.recipeRecording) throw new Error(`already recording "${meta.recipeRecording.name}" in ${session} — \`tirno recipe end\` or \`cancel\` first`);
        for (const v of opts.var as string[]) if (!process.env[v]) warn(`--var ${v}: not set in this environment — values equal to it cannot be masked`);
        let url = '';
        try {
          const { browser } = await connect(session);
          url = (await getActivePage(browser)).url();
          browser.disconnect();
        } catch { /* 페이지가 없어도 기록은 시작한다 */ }
        const rec: recipes.RecipeRecording = {
          name, domain: recipes.domainOf(url), ...(url ? { startUrl: url } : {}), vars: opts.var, steps: [], startedAt: new Date().toISOString(),
        };
        store.update(session, { recipeRecording: rec });
        success(`recording recipe "${name}" for ${rec.domain} in session ${session} — run your commands, then \`tirno recipe end\``);
        if (opts.var.length) info(`masking values of: ${(opts.var as string[]).map(v => `$${v}`).join(' ')}`);
      } catch (e) {
        fail(e);
      }
    });

  recipe
    .command('end')
    .description('Stop recording and save the recipe')
    .option('-s, --session <name>', 'Session name')
    .action((opts) => {
      try {
        const session = sessionOf(opts);
        const meta = store.get(session);
        const rec = meta.recipeRecording;
        if (!rec) throw new Error(`session ${session} is not recording — \`tirno recipe begin <name>\``);
        if (rec.steps.length === 0) {
          store.update(session, { recipeRecording: undefined });
          throw new Error(`recipe "${rec.name}" had no steps — nothing saved`);
        }
        const r: recipes.Recipe = {
          schemaVersion: recipes.RECIPE_SCHEMA_VERSION, name: rec.name, domain: rec.domain,
          ...(rec.startUrl ? { startUrl: rec.startUrl } : {}),
          vars: rec.vars, steps: rec.steps, recordedAt: new Date().toISOString(), runs: { ok: 0, failed: 0 },
        };
        const p = recipes.save(r);
        store.update(session, { recipeRecording: undefined });
        success(`saved recipe "${r.name}" (${r.steps.length} step${r.steps.length === 1 ? '' : 's'}) → ${p}`);
        info(`replay: tirno recipe run ${r.name}${r.vars.map(v => ` ${v}=…`).join('')}`);
      } catch (e) {
        fail(e);
      }
    });

  recipe
    .command('cancel')
    .description('Stop recording without saving')
    .option('-s, --session <name>', 'Session name')
    .action((opts) => {
      try {
        const session = sessionOf(opts);
        const rec = store.get(session).recipeRecording;
        if (!rec) throw new Error(`session ${session} is not recording`);
        store.update(session, { recipeRecording: undefined });
        success(`discarded recording "${rec.name}" (${rec.steps.length} steps)`);
      } catch (e) {
        fail(e);
      }
    });

  recipe
    .command('ls')
    .description('List recipes')
    .option('--domain <d>', 'Only this domain')
    .option('--json', 'JSON')
    .action((opts) => {
      const all = recipes.list(opts.domain);
      if (opts.json) { console.log(JSON.stringify(all, null, 2)); return; }
      if (all.length === 0) { info('no recipes — `tirno recipe begin <name>` to record one'); return; }
      console.log(formatTable(['DOMAIN', 'NAME', 'STEPS', 'VARS', 'RUNS ok/failed', 'RECORDED'],
        all.map(r => [r.domain, r.name, String(r.steps.length), r.vars.join(',') || '-', `${r.runs.ok}/${r.runs.failed}${r.runs.lastFailedStep ? ` (last failed at ${r.runs.lastFailedStep})` : ''}`, r.recordedAt.slice(0, 16).replace('T', ' ')])));
    });

  recipe
    .command('show')
    .description('Print a recipe\'s steps')
    .argument('<name>')
    .option('--domain <d>', 'Which domain\'s recipe, when the name exists in several')
    .option('--json', 'JSON')
    .action((name: string, opts) => {
      try {
        const r = recipes.find(name, opts.domain);
        if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
        info(`${r.domain} / ${r.name} — ${r.steps.length} steps${r.startUrl ? ` · starts at ${r.startUrl}` : ''}${r.vars.length ? ` · vars ${r.vars.map(v => '$' + v).join(' ')}` : ''}`);
        r.steps.forEach((s, i) => console.log(` ${String(i + 1).padStart(2)}  tirno ${s.argv.join(' ')}${s.from ? chalk.dim(`   (was ${s.from})`) : ''}`));
        info(`file: ${recipes.recipePath(r.domain, r.name)}`);
      } catch (e) {
        fail(e);
      }
    });

  recipe
    .command('rm')
    .description('Delete a recipe')
    .argument('<name>')
    .option('--domain <d>', 'Which domain\'s recipe')
    .action((name: string, opts) => {
      try {
        const r = recipes.find(name, opts.domain);
        recipes.remove(r.domain, r.name);
        success(`removed ${r.domain} / ${r.name}`);
      } catch (e) {
        fail(e);
      }
    });

  recipe
    .command('run')
    .description('Replay a recipe in this session, step by step. Stops at the first step that fails and says which; pass NAME=value for its $vars (or export them)')
    .argument('<name>')
    .argument('[vars...]', 'NAME=value for each $NAME in the recipe')
    .option('-s, --session <name>', 'Session name')
    .option('--domain <d>', 'Which domain\'s recipe')
    .option('--from <step>', 'Start at this step number (1-based) — after fixing a failed one', (v: string) => Number(v))
    .option('--no-start-url', 'Do not navigate to the recorded start URL first')
    .option('--dry-run', 'Print the steps that would run, with $vars resolved, and exit')
    .action(async (name: string, varArgs: string[], opts) => {
      try {
        const session = sessionOf(opts);
        const { values, rest } = recipes.parseRunVars(varArgs);
        if (rest.length) throw new Error(`unexpected argument(s): ${rest.join(' ')} — vars are NAME=value`);
        let preferDomain: string | undefined = opts.domain;
        if (!preferDomain) {
          try {
            const { browser } = await connect(session);
            preferDomain = recipes.domainOf((await getActivePage(browser)).url());
            browser.disconnect();
          } catch { /* 도메인 없이 찾는다 */ }
        }
        const r = recipes.find(name, preferDomain);
        const steps = r.steps.map(s => recipes.expandVars(s.argv, values));   // 빠진 변수는 여기서 먼저 걸린다
        const from = Math.max(1, opts.from ?? 1);
        // 비밀은 출력에도 없다 — 단계 표기와 결과 요약 양쪽에서 가린다
        const mask = masker(r.vars.map(v => values[v] ?? process.env[v]).filter((v): v is string => !!v));

        if (opts.dryRun) {
          info(`${r.domain} / ${r.name} — ${steps.length} steps (dry run)`);
          steps.forEach((argv, i) => console.log(` ${String(i + 1).padStart(2)}  tirno ${mask(argv.join(' '))}`));
          return;
        }

        if (opts.startUrl !== false && r.startUrl && from === 1) {
          const nav = await runStep(['nav', r.startUrl], session);
          if (!nav.ok) throw new TirnoError(`could not open ${r.startUrl}: ${nav.summary}`, 'recipe_step_failed', { step: 0, argv: ['nav', r.startUrl], code: nav.code });
          console.log(`  0  tirno nav ${r.startUrl}   ${chalk.dim(mask(nav.summary))}`);
        }
        for (let i = from - 1; i < steps.length; i++) {
          const argv = steps[i];
          const shown = mask(argv.join(' '));
          const res = await runStep(argv, session);
          res.summary = mask(res.summary);
          if (!res.ok) {
            recipes.save({ ...r, runs: { ...r.runs, failed: r.runs.failed + 1, lastRunAt: new Date().toISOString(), lastFailedStep: i + 1 } });
            console.log(` ${String(i + 1).padStart(2)}  tirno ${shown}   ${chalk.red('✗')}`);
            throw new TirnoError(
              `recipe ${r.name}: step ${i + 1} failed — ${res.summary}\n  fix the page or the step, then \`tirno recipe run ${r.name} --from ${i + 1}\``,
              'recipe_step_failed', { step: i + 1, argv, code: res.code },
            );
          }
          console.log(` ${String(i + 1).padStart(2)}  tirno ${shown}   ${chalk.dim(res.summary)}`);
        }
        recipes.save({ ...r, runs: { ...r.runs, ok: r.runs.ok + 1, lastRunAt: new Date().toISOString(), lastFailedStep: undefined } });
        success(`recipe ${r.name}: ${steps.length - from + 1} step${steps.length - from + 1 === 1 ? '' : 's'} ok`);
      } catch (e) {
        fail(e);
      }
    });
}
