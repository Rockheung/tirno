/**
 * `tirno mcp` — stdio MCP 서버, 툴은 schema 에서 자동 (#215).
 *
 * JSON-RPC 2.0 을 줄 단위로 stdin 에서 읽고 stdout 에 쓴다. 로그는 전부 stderr 다 — stdout 은
 * 프로토콜 채널이라 한 글자도 새면 클라이언트가 깨진다. 툴 호출은 tirno 자신을 자식으로
 * 친다(재생과 같은 길) — 결과 텍스트가 곧 사용자가 터미널에서 보는 것이다.
 *
 * 앵커(chrome-devtools-mcp 를 디렉터리에 붙이는 우회)가 필요 없어진다.
 */
import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSchema, type CliSchema } from '../core/schema.js';
import { toolsFor, commandOfTool, argvFor, CORE_TOOLS } from '../mcp/tools.js';
import { fail } from '../output/formatter.js';

const run = promisify(execFile);
const PROTOCOL = '2025-06-18';

interface Request { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

export function registerMcpCommand(program: Command, root: () => Command): void {
  program
    .command('mcp')
    .description('Serve tirno as an MCP server over stdio. Tools are generated from `tirno schema`, so they never lag the CLI. `--tools core` (default) is the everyday set; `all` is every command')
    .option('--tools <profile>', 'core | all', 'core')
    .option('--session <name>', 'Default session for every call (a call\'s own `session` wins)')
    .action(async (opts) => {
      try {
        const profile = opts.tools === 'all' ? 'all' : opts.tools === 'core' ? 'core' : null;
        if (!profile) throw new Error(`--tools takes core | all (got "${opts.tools}")`);
        const schema = buildSchema(root());
        await serve(schema, profile, opts.session);
      } catch (e) {
        fail(e);
      }
    });
}

async function serve(schema: CliSchema, profile: 'core' | 'all', defaultSession?: string): Promise<void> {
  const tools = toolsFor(schema, profile);
  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const log = (s: string) => process.stderr.write(`[tirno mcp] ${s}\n`);
  log(`ready — ${tools.length} tools (${profile})${defaultSession ? ` · session ${defaultSession}` : ''}`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: Request;
    try { req = JSON.parse(line) as Request; } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    const reply = (result: unknown) => { if (req.id !== undefined) write({ jsonrpc: '2.0', id: req.id, result }); };
    const error = (code: number, message: string) => { if (req.id !== undefined) write({ jsonrpc: '2.0', id: req.id, error: { code, message } }); };
    try {
      switch (req.method) {
        case 'initialize':
          reply({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'tirno', version: schema.version } });
          break;
        case 'notifications/initialized':
        case 'notifications/cancelled':
          break;
        case 'ping':
          reply({});
          break;
        case 'tools/list':
          reply({ tools });
          break;
        case 'tools/call': {
          const name = String(req.params?.name ?? '');
          const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
          const cmd = commandOfTool(name, schema);
          if (!cmd || !tools.some(t => t.name === name)) { error(-32602, `unknown tool ${name}`); break; }
          if (defaultSession && args['session'] === undefined && cmd.options.some(o => o.flags.includes('--session'))) args['session'] = defaultSession;
          const argv = argvFor(cmd, args);
          log(`→ tirno ${argv.join(' ')}`);
          const r = await callTirno(argv);
          reply({ content: [{ type: 'text', text: r.text || '(no output)' }], isError: !r.ok, ...(r.code ? { _meta: { code: r.code } } : {}) });
          break;
        }
        default:
          error(-32601, `method not found: ${req.method}`);
      }
    } catch (e) {
      error(-32603, (e as Error).message);
    }
  }
}

async function callTirno(argv: string[]): Promise<{ ok: boolean; text: string; code?: string }> {
  const args = [process.argv[1], ...argv].filter(Boolean);
  try {
    const { stdout, stderr } = await run(process.execPath, args, { env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
    return { ok: true, text: `${stdout}${stderr}`.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean };
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    return { ok: false, text: err.killed ? `${text}\n(timed out)` : text, code: /code: ([a-z_]+)/.exec(text)?.[1] };
  }
}

export { CORE_TOOLS };
