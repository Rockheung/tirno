import type { Command } from 'commander';

/**
 * Machine-readable description of the whole command tree — `tirno schema`.
 *
 * `--help` is prose written for a person: subcommands live one level down, the
 * 198 option lines are scattered across 69 endpoints, and multi-line
 * descriptions interleave with command lists so that scraping it yields flags
 * that do not exist. Anything reading this tool programmatically needs a form
 * that is parsed, not scraped.
 *
 * Shape follows The CLI Spec v0.3 (clispec.dev), with one addition: `destructive`.
 * The spec's `effects` triad cannot say "this removes a logged-in browser
 * profile", and that is the one fact a caller must have before running a
 * command here.
 *
 * Structure is derived from commander at runtime, so it cannot drift from the
 * CLI. Semantics cannot be derived and are declared in SEMANTICS below —
 * test/schema.test.ts fails when an endpoint is missing one, which is what keeps
 * a newly added command from shipping unclassified.
 */

export type Effects = 'read_only' | 'idempotent' | 'non_idempotent';
export type OutputKind = 'data' | 'stream' | 'opaque';
export type Cardinality = 'single' | 'bounded' | 'unbounded';

export interface CommandSemantics {
  effects: Effects;
  output_kind: OutputKind;
  cardinality?: Cardinality;
  /** Removes something a person would miss — a browser, a profile, a saved artifact. */
  destructive?: true;
}

export interface SchemaArg {
  name: string;
  required: boolean;
  variadic: boolean;
  description?: string;
}

export interface SchemaOption {
  flags: string;
  description?: string;
  default?: unknown;
}

export interface SchemaCommand extends CommandSemantics {
  name: string;
  /**
   * 같은 명령의 다른 이름, **전체 경로로**. `permissions ls` 의 `perm ls` 처럼.
   * 별칭은 사람이 실제로 치는 이름인데 예전에는 이 표에 아예 없었다 — 기계가 읽는
   * 표면이 사람이 쓰는 표면보다 좁으면, 그 차이만큼은 문서를 읽어야만 알 수 있다.
   */
  aliases?: string[];
  summary: string;
  args: SchemaArg[];
  options: SchemaOption[];
  /** Accepts `-- <chrome flags>` passed straight through to the browser. */
  passthrough?: true;
}

export interface CliSchema {
  clispec: '0.3';
  name: string;
  version: string;
  summary: string;
  global_args: SchemaOption[];
  commands: SchemaCommand[];
  errors: Array<{ kind: string; exit_code: number; description: string }>;
}

/**
 * Every endpoint's semantics, keyed by its full path.
 *
 * `destructive` is not "writes something" — `screenshot` writes a file and is
 * not marked. It is "removes state whose loss is felt": a running browser, a
 * profile directory (someone's logged-in session), a saved trail or recording.
 */
export const SEMANTICS: Record<string, CommandSemantics> = {
  // ---- sessions
  'new':          { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'restart':      { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single', destructive: true },
  'ls':           { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },
  'attach':       { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'kill':         { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single', destructive: true },
  'gc':           { effects: 'non_idempotent', output_kind: 'data', cardinality: 'unbounded', destructive: true },
  'drift':        { effects: 'read_only', output_kind: 'data', cardinality: 'bounded' },
  'rename':       { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'export':       { effects: 'read_only', output_kind: 'data', cardinality: 'single' },

  // ---- chrome 실행 파일
  'chrome show':  { effects: 'read_only', output_kind: 'data', cardinality: 'bounded' },
  'chrome set':   { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'chrome rm':    { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'setup':        { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },

  // ---- anchors
  'anchor ls':    { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },
  'anchor set':   { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'anchor rm':    { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },

  // ---- self
  'update':       { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },

  // ---- permissions
  'permissions ls':     { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },
  'permissions grant':  { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'permissions revoke': { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'headers set':        { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'headers rm':         { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'headers ls':         { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },

  // ---- service workers
  'sw status':          { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },

  // ---- navigation
  'nav':          { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'reload':       { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'back':         { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'forward':      { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'pages':        { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },
  'select':       { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'new-tab':      { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'close-tab':    { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single', destructive: true },

  // ---- inspection
  'screenshot':   { effects: 'idempotent', output_kind: 'opaque', cardinality: 'single' },
  'snapshot':     { effects: 'idempotent', output_kind: 'data', cardinality: 'unbounded' },
  'console':      { effects: 'read_only', output_kind: 'data', cardinality: 'bounded' },
  'network':      { effects: 'idempotent', output_kind: 'data', cardinality: 'bounded' },
  'net ls':       { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },
  'net save':     { effects: 'non_idempotent', output_kind: 'opaque', cardinality: 'unbounded' },
  'net export':   { effects: 'non_idempotent', output_kind: 'opaque', cardinality: 'single' },

  // ---- input
  'click':        { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'fill':         { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'type':         { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'press':        { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'hover':        { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'drag':         { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'scroll':       { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'wait':         { effects: 'read_only', output_kind: 'data', cardinality: 'single' },
  'wait-for':     { effects: 'read_only', output_kind: 'data', cardinality: 'single' },
  'upload':       { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },

  // ---- execution
  'eval':         { effects: 'non_idempotent', output_kind: 'opaque', cardinality: 'single' },
  'cdp':          { effects: 'non_idempotent', output_kind: 'opaque', cardinality: 'single' },
  'emulate':      { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'broadcast':    { effects: 'non_idempotent', output_kind: 'data', cardinality: 'unbounded' },
  'diff':         { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },

  // ---- diagnostics
  'stall':            { effects: 'read_only', output_kind: 'stream', cardinality: 'bounded' },
  'audit':            { effects: 'idempotent', output_kind: 'data', cardinality: 'single' },
  'trace':            { effects: 'idempotent', output_kind: 'opaque', cardinality: 'single' },
  'trace start':      { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'trace stop':       { effects: 'non_idempotent', output_kind: 'opaque', cardinality: 'single' },
  'trace insight':    { effects: 'read_only', output_kind: 'data', cardinality: 'bounded' },
  'memory':           { effects: 'idempotent', output_kind: 'opaque', cardinality: 'single' },
  'memory load':      { effects: 'read_only', output_kind: 'data', cardinality: 'single' },
  'memory details':   { effects: 'read_only', output_kind: 'data', cardinality: 'bounded' },
  'screencast start': { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'screencast stop':  { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'stats':            { effects: 'read_only', output_kind: 'data', cardinality: 'bounded' },

  // ---- cache / vision / trails (the value flow)
  'cache list':   { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },
  'cache load':   { effects: 'read_only', output_kind: 'data', cardinality: 'bounded' },
  'cache prune':  { effects: 'non_idempotent', output_kind: 'data', cardinality: 'unbounded', destructive: true },

  'record start': { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'record stop':  { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'record list':  { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },
  'record rm':    { effects: 'idempotent', output_kind: 'data', cardinality: 'single', destructive: true },
  'replay':       { effects: 'non_idempotent', output_kind: 'data', cardinality: 'bounded' },

  'trail capture': { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'trail save':    { effects: 'non_idempotent', output_kind: 'data', cardinality: 'single' },
  'trail list':    { effects: 'read_only', output_kind: 'data', cardinality: 'unbounded' },
  'trail show':    { effects: 'read_only', output_kind: 'data', cardinality: 'bounded' },
  'trail replay':  { effects: 'non_idempotent', output_kind: 'data', cardinality: 'bounded' },
  'trail rm':      { effects: 'idempotent', output_kind: 'data', cardinality: 'single', destructive: true },

  // ---- self-description
  'schema':       { effects: 'read_only', output_kind: 'data', cardinality: 'single' },
};

/**
 * Commands that forward everything after `--` to chrome. The flags are chrome's,
 * not tirno's, so no schema can enumerate them — but a caller has to know the
 * door exists.
 */
/**
 * `-- <chrome-flags>` 를 받는 명령. 목록을 따로 들지 않고 **usage line 에서 읽는다** —
 * 하나를 고치고 다른 하나를 잊는 자리를 없앤다. `--help` 에는 있는데 schema 에는 없던
 * 상태(그 반대도)가 #134 의 절반이었다.
 */
const PASSTHROUGH_MARKER = '-- <chrome-flags>';

/** Exit codes are uniform: every command exits 1 on failure. */
const ERRORS = [
  { kind: 'failure', exit_code: 1, description: 'Any error — a failed navigation, an unknown session, a refused kill. tirno does not use distinct codes per class.' },
  { kind: 'ok', exit_code: 0, description: 'Success. For `drift`, also means declared and running flags agree.' },
];

function argsOf(cmd: Command): SchemaArg[] {
  // `registeredArguments` is commander 12+; older builds expose `_args`.
  const raw = (cmd as unknown as { registeredArguments?: unknown[]; _args?: unknown[] });
  const list = (raw.registeredArguments ?? raw._args ?? []) as Array<{
    name(): string; required: boolean; variadic: boolean; description: string;
  }>;
  return list.map(a => ({
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
    ...(a.description ? { description: a.description } : {}),
  }));
}

function optionsOf(cmd: Command): SchemaOption[] {
  return cmd.options
    .filter(o => o.flags !== '-h, --help')
    .map(o => ({
      flags: o.flags,
      ...(o.description ? { description: o.description } : {}),
      ...(o.defaultValue === undefined ? {} : { default: o.defaultValue }),
    }));
}

function walk(cmd: Command, prefixes: string[], out: SchemaCommand[]): void {
  // 별칭이 있으면 이 명령에 이르는 경로가 여럿이다. 첫 번째가 정본이고 나머지가 별칭인데,
  // 자식에게도 그대로 물려줘야 한다 — `net` 이 `network` 의 별칭이면 `net ls` 도 진짜다.
  const paths = prefixes.flatMap(p =>
    [cmd.name(), ...cmd.aliases()].map(n => (p ? `${p} ${n}` : n)));
  const path = paths[0]!;
  const children = cmd.commands.filter(c => c.name() !== 'help');

  // A parent can also be runnable (`tirno trace --duration 5` alongside
  // `tirno trace start`), so having children does not exclude it from the list.
  const runnable = children.length === 0 || SEMANTICS[path] !== undefined;

  if (runnable) {
    const sem = SEMANTICS[path];
    out.push({
      name: path,
      ...(paths.length > 1 ? { aliases: paths.slice(1) } : {}),
      summary: cmd.description() || '',
      args: argsOf(cmd),
      options: optionsOf(cmd),
      ...(cmd.usage().includes(PASSTHROUGH_MARKER) ? { passthrough: true as const } : {}),
      ...(sem ?? { effects: 'non_idempotent' as const, output_kind: 'opaque' as const }),
    });
  }

  for (const child of children) walk(child, paths, out);
}

export function buildSchema(program: Command): CliSchema {
  const commands: SchemaCommand[] = [];
  for (const c of program.commands.filter(c => c.name() !== 'help')) {
    walk(c, [''], commands);
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));

  return {
    clispec: '0.3',
    name: program.name(),
    version: program.version() ?? '0.0.0',
    summary: program.description(),
    global_args: optionsOf(program),
    commands,
    errors: ERRORS,
  };
}

