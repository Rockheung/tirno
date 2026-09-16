/**
 * `tirno schema` → MCP 툴 (#215).
 *
 * 손으로 유지하는 툴 정의가 없다. 명령의 positional 은 필수/선택 문자열 속성, 옵션은 긴 플래그
 * 이름의 속성(값이 있으면 문자열, 없으면 불리언)이 된다. 명령을 추가하면 툴이 생긴다 —
 * `test/schema.test.ts` 가 옵션이 schema 에 빠지지 않게 지키므로 툴도 낡을 수 없다.
 */
import type { CliSchema, SchemaCommand } from '../core/schema.js';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

/** `core` — 일상적인 자동화에 드는 것. 나머지는 `all`. */
export const CORE_TOOLS = new Set([
  'new', 'ls', 'kill', 'nav', 'back', 'snapshot', 'click', 'fill', 'type', 'press', 'hover', 'scroll', 'wait-for',
  'eval', 'screenshot', 'expect', 'ensure', 'forms', 'links', 'read', 'explain', 'a11y', 'recipe run', 'recipe ls',
]);

export function toolName(command: string): string {
  return `tirno_${command.replace(/[^a-z0-9]+/gi, '_')}`;
}

export function commandOfTool(name: string, schema: CliSchema): SchemaCommand | undefined {
  return schema.commands.find(c => toolName(c.name) === name);
}

interface OptionShape { key: string; long: string; takesValue: boolean; negated: boolean; description?: string; default?: unknown }

/** `-s, --session <name>` → { key: 'session', long: '--session', takesValue: true } · `--no-delta` → negated */
export function optionShape(flags: string, description?: string, def?: unknown): OptionShape | null {
  const long = /--([a-z0-9-]+)/i.exec(flags)?.[1];
  if (!long) return null;
  const takesValue = /<[^>]+>/.test(flags);
  const negated = long.startsWith('no-');
  const key = (negated ? long.slice(3) : long).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return { key, long: `--${long}`, takesValue, negated, description, default: def };
}

export function toolFromCommand(c: SchemaCommand): McpTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of c.args) {
    properties[a.name] = a.variadic
      ? { type: 'array', items: { type: 'string' }, description: a.description ?? '' }
      : { type: 'string', description: a.description ?? '' };
    if (a.required) required.push(a.name);
  }
  for (const o of c.options) {
    const s = optionShape(o.flags, o.description, o.default);
    if (!s || s.long === '--help') continue;
    if (s.negated) {
      // `--no-delta` → delta: boolean (false 면 플래그를 붙인다)
      properties[s.key] = { type: 'boolean', description: `${s.description ?? ''} (set false to pass ${s.long})`.trim(), default: true };
    } else {
      properties[s.key] = s.takesValue
        ? { type: 'string', description: s.description ?? '', ...(s.default !== undefined ? { default: String(s.default) } : {}) }
        : { type: 'boolean', description: s.description ?? '' };
    }
  }
  if (c.passthrough) properties['chromeFlags'] = { type: 'array', items: { type: 'string' }, description: 'Raw chrome flags passed after --' };
  return {
    name: toolName(c.name),
    description: c.summary,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    annotations: {
      title: `tirno ${c.name}`,
      readOnlyHint: c.effects === 'read_only',
      destructiveHint: !!c.destructive,
      idempotentHint: c.effects !== 'non_idempotent',
      openWorldHint: true,
    },
  };
}

export function toolsFor(schema: CliSchema, profile: 'core' | 'all'): McpTool[] {
  return schema.commands
    .filter(c => profile === 'all' || CORE_TOOLS.has(c.name))
    .map(toolFromCommand);
}

/** 툴 인자 → argv. positional 은 선언 순서, 옵션은 뒤에. */
export function argvFor(c: SchemaCommand, args: Record<string, unknown>): string[] {
  const argv: string[] = c.name.split(' ');
  for (const a of c.args) {
    const v = args[a.name];
    if (v === undefined || v === null) continue;
    if (a.variadic && Array.isArray(v)) argv.push(...v.map(String));
    else argv.push(String(v));
  }
  const seen = new Set<string>();
  for (const o of c.options) {
    const s = optionShape(o.flags);
    if (!s || seen.has(s.key)) continue;
    seen.add(s.key);
    const v = args[s.key];
    if (v === undefined || v === null) continue;
    if (s.negated) { if (v === false) argv.push(s.long); continue; }
    if (s.takesValue) argv.push(s.long, String(v));
    else if (v === true) argv.push(s.long);
  }
  if (c.passthrough && Array.isArray(args['chromeFlags']) && args['chromeFlags'].length) argv.push('--', ...(args['chromeFlags'] as unknown[]).map(String));
  return argv;
}
