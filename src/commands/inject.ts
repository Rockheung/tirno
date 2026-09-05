import { Command } from 'commander';
import crypto from 'node:crypto';
import * as store from '../core/session-store.js';
import { connect } from '../core/chrome-connector.js';
import { resolveExpression } from './eval.js';
import { formatTable, success, info, error } from '../output/formatter.js';

// document-start 훅. `eval` 이 페이지 로드 **뒤**에 도는 것과 갈리는 지점이다 —
// 부팅 중에 이미 나간 요청을 잡거나, 페이지가 리스너를 걸기 전에 가드를 심으려면
// 그 전에 돌아야 한다. `eval` 을 리로드 직후에 밀어 넣는 식으로는 경합을 못 이긴다.
//
// `Page.addScriptToEvaluateOnNewDocument` 는 CDP 연결 수명에 묶여 명령이 끝나면
// 사라지므로, 소스를 세션 메타에 저장하고 connect 마다 다시 건다.

/** 같은 소스는 같은 id 를 받는다 — 두 번 넣어도 두 벌이 되지 않는다. */
export function idOf(source: string): string {
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 8);
}

export function firstLine(source: string, width = 48): string {
  const line = source.split('\n').find(l => l.trim().length > 0)?.trim() ?? '';
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

function resolveName(opts: { session?: string }): string {
  const name = opts.session ?? store.getActive();
  if (!name) throw new Error('No active session');
  return name;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** 등록만 다시 하고 끊는다 — connect 가 저장된 훅을 거는 자리다. */
async function reapply(name: string): Promise<void> {
  const { browser } = await connect(name);
  browser.disconnect();
}

export function registerInjectCommands(program: Command): void {
  const cmd = program
    .command('inject')
    .description('Scripts that run at document-start on every navigation, for the life of the session');

  cmd.addHelpText('after', INJECT_HELP);

  cmd
    .command('add')
    .description('Register a document-start script. Stored in the session and re-applied on every connect, so it outlives the command that added it')
    .argument('[source]', 'JS source, or "-" to read stdin')
    .option('-s, --session <name>', 'Session name')
    .option('--file <path>', 'Read the script from a file')
    .action(async (source: string | undefined, opts) => {
      try {
        const name = resolveName(opts);
        const js = await resolveExpression(source, opts.file, readStdin, process.stdin.isTTY ?? false);
        const id = idOf(js);
        const cur = store.get(name).injects ?? [];
        if (cur.some(i => i.id === id)) { info(`Already injected as ${id} — same source.`); return; }
        store.update(name, { injects: [...cur, { id, source: js, addedAt: new Date().toISOString() }] });
        await reapply(name);
        success(`Injected ${id} — runs at document-start from the next navigation (\`tirno reload\` to see it now)`);
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('rm')
    .description('Remove one script by id, or all when no id is given')
    .argument('[id]', 'Script id from `inject ls`; omit to clear all')
    .option('-s, --session <name>', 'Session name')
    .action(async (id: string | undefined, opts) => {
      try {
        const name = resolveName(opts);
        const cur = store.get(name).injects ?? [];
        if (id && !cur.some(i => i.id === id)) { info(`No injected script '${id}'.`); return; }
        store.update(name, { injects: id ? cur.filter(i => i.id !== id) : [] });
        // 이미 걸린 등록은 이 연결에서만 살아 있었다. 다음 connect 가 남은 것만 건다.
        await reapply(name);
        success(id ? `Removed ${id} — gone from the next navigation` : 'Cleared all injected scripts');
      } catch (e) { error((e as Error).message); process.exit(1); }
    });

  cmd
    .command('ls')
    .description('List the document-start scripts registered on a session')
    .option('-s, --session <name>', 'Session name')
    .option('--json', 'Output as JSON — includes full source')
    .action((opts) => {
      try {
        const name = resolveName(opts);
        const injects = store.get(name).injects ?? [];
        if (opts.json) { console.log(JSON.stringify(injects, null, 2)); return; }
        if (!injects.length) { info(`No injected scripts for '${name}'.`); return; }
        console.log(formatTable(
          ['ID', 'BYTES', 'ADDED', 'FIRST LINE'],
          injects.map(i => [i.id, String(Buffer.byteLength(i.source)), i.addedAt.slice(0, 19).replace('T', ' '), firstLine(i.source)]),
        ));
      } catch (e) { error((e as Error).message); process.exit(1); }
    });
}

const INJECT_HELP = `
Runs before the page's own scripts, on every navigation — which is what \`eval\`
cannot do. Use it to hook XMLHttpRequest before the app boots, to guard a
listener before the page installs its own, or to plant a timeline sampler.

The source is stored in the session, not a path: a file that changes or
disappears would leave the session claiming a hook nobody can read back.

  tirno inject add 'window.__t0 = Date.now()'
  tirno inject add --file ./hook-xhr.js
  cat ./hook-xhr.js | tirno inject add
  tirno inject ls
  tirno inject rm a1b2c3d4

Registering does not touch the current document — a document-start hook that
runs after boot is not the same hook. Reload to see it take effect.

tirno's own stubs (beforeunload neutralisation, the recorder) go in first, so
a listener your script installs is filtered the same way a page's would be.
`;
