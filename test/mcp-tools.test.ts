import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolName, optionShape, toolFromCommand, argvFor, toolsFor } from '../src/mcp/tools.js';
import type { SchemaCommand, CliSchema } from '../src/core/schema.js';

// schema → MCP 툴 (#215). 손으로 유지하는 정의가 없다 — 여기서 잠그는 것은 변환 규칙이다.

const click: SchemaCommand = {
  name: 'click', summary: 'Click', effects: 'non_idempotent', output_kind: 'data', cardinality: 'single',
  args: [{ name: 'target', required: true, variadic: false, description: 't' }, { name: 'name', required: false, variadic: false }],
  options: [{ flags: '-s, --session <name>' }, { flags: '--dbl', description: 'Double' }, { flags: '--no-delta' }, { flags: '--stale-ok' }],
};

test('툴 이름 — 공백·하이픈은 밑줄', () => {
  assert.equal(toolName('click'), 'tirno_click');
  assert.equal(toolName('recipe run'), 'tirno_recipe_run');
  assert.equal(toolName('wait-for'), 'tirno_wait_for');
});

test('optionShape — 긴 플래그가 키, <값> 이면 문자열, no- 는 부정', () => {
  assert.deepEqual(optionShape('-s, --session <name>'), { key: 'session', long: '--session', takesValue: true, negated: false, description: undefined, default: undefined });
  assert.equal(optionShape('--stale-ok')!.key, 'staleOk');
  assert.deepEqual(optionShape('--no-delta')!, { key: 'delta', long: '--no-delta', takesValue: false, negated: true, description: undefined, default: undefined });
  assert.equal(optionShape('-x'), null);
});

test('toolFromCommand — positional 은 필수/선택, 옵션은 속성, 힌트는 effects 에서', () => {
  const t = toolFromCommand(click);
  assert.equal(t.name, 'tirno_click');
  assert.deepEqual(t.inputSchema.required, ['target']);
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['target', 'name', 'session', 'dbl', 'delta', 'staleOk']);
  assert.deepEqual((t.inputSchema.properties as Record<string, { type: string; default?: unknown }>)['delta'], { type: 'boolean', description: '(set false to pass --no-delta)', default: true });
  assert.equal(t.annotations.readOnlyHint, false); assert.equal(t.annotations.idempotentHint, false);
});

test('argvFor — positional 순서, 옵션 뒤에, delta:false 는 --no-delta, 불리언 false 는 생략', () => {
  assert.deepEqual(argvFor(click, { target: 'button', name: 'Go', session: 's1', dbl: true, delta: false, staleOk: false }),
    ['click', 'button', 'Go', '--session', 's1', '--dbl', '--no-delta']);
  assert.deepEqual(argvFor(click, { target: '@3' }), ['click', '@3']);
});

test('variadic 과 passthrough', () => {
  const run: SchemaCommand = { name: 'recipe run', summary: '', effects: 'non_idempotent', output_kind: 'data', cardinality: 'bounded',
    args: [{ name: 'name', required: true, variadic: false }, { name: 'vars', required: false, variadic: true }], options: [] };
  assert.deepEqual(argvFor(run, { name: 'login', vars: ['A=1', 'B=2'] }), ['recipe', 'run', 'login', 'A=1', 'B=2']);
  const nw: SchemaCommand = { ...click, name: 'new', args: [{ name: 'name', required: true, variadic: false }], options: [], passthrough: true };
  assert.deepEqual(argvFor(nw, { name: 'x', chromeFlags: ['--no-sandbox'] }), ['new', 'x', '--', '--no-sandbox']);
  assert.ok('chromeFlags' in toolFromCommand(nw).inputSchema.properties);
});

test('프로파일 — core 는 부분집합, all 은 전부', () => {
  const schema = { commands: [click, { ...click, name: 'gc' }, { ...click, name: 'snapshot' }] } as unknown as CliSchema;
  assert.deepEqual(toolsFor(schema, 'core').map(t => t.name), ['tirno_click', 'tirno_snapshot']);
  assert.equal(toolsFor(schema, 'all').length, 3);
});
