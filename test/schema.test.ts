import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { buildSchema, SEMANTICS } from '../src/core/schema.js';

// The point of `tirno schema` is that nothing hand-maintained can drift from the
// CLI. Structure is derived from commander, so only the semantics table can rot —
// these tests are what stop it. A command added without a SEMANTICS entry ships
// as `non_idempotent`/`opaque`, which is the safe default but also a lie about a
// read-only command; the coverage test fails first so the lie never ships.

async function realProgram(): Promise<Command> {
  const program = new Command();
  program.name('tirno').description('test').version('0.0.0');
  const mods = [
    ['session', 'registerSessionCommands'], ['anchor', 'registerAnchorCommands'],
    ['nav', 'registerNavCommands'], ['inspect', 'registerInspectCommands'],
    ['input', 'registerInputCommands'], ['eval', 'registerEvalCommand'],
    ['emulate', 'registerEmulateCommand'], ['perf', 'registerPerfCommands'],
    ['multi', 'registerMultiCommands'], ['cache', 'registerCacheCommands'],
    ['cdp', 'registerCdpCommands'],
    ['record', 'registerRecordCommands'], ['replay', 'registerReplayCommand'],
    ['trail', 'registerTrailCommands'],
    ['stats', 'registerStatsCommand'], ['audit', 'registerAuditCommand'],
    ['screencast', 'registerScreencastCommands'], ['schema', 'registerSchemaCommand'],
  ] as const;
  for (const [file, fn] of mods) {
    const mod = await import(`../src/commands/${file}.js`) as Record<string, (p: Command) => void>;
    mod[fn](program);
  }
  return program;
}

test('every endpoint has declared semantics', async () => {
  const schema = buildSchema(await realProgram());
  const undeclared = schema.commands.filter(c => SEMANTICS[c.name] === undefined).map(c => c.name);
  assert.deepEqual(undeclared, [], `declare these in SEMANTICS: ${undeclared.join(', ')}`);
});

test('no semantics entry describes a command that no longer exists', async () => {
  const names = new Set(buildSchema(await realProgram()).commands.map(c => c.name));
  const orphans = Object.keys(SEMANTICS).filter(k => !names.has(k));
  assert.deepEqual(orphans, [], `remove from SEMANTICS: ${orphans.join(', ')}`);
});

// The whole reason for a machine-readable surface: an agent must be able to see
// that `kill` removes a browser before it runs it, without reading prose.
test('destructive commands are flagged', async () => {
  const schema = buildSchema(await realProgram());
  const destructive = schema.commands.filter(c => c.destructive).map(c => c.name).sort();
  assert.deepEqual(destructive, [
    'cache prune', 'close-tab', 'gc', 'kill',
    'record rm', 'restart', 'trail rm',
  ]);
});

test('read_only commands are never destructive', async () => {
  for (const c of buildSchema(await realProgram()).commands) {
    if (c.effects === 'read_only') assert.equal(c.destructive, undefined, c.name);
  }
});

// Subcommands are exactly what `--help` hides at the top level, so they are the
// thing the schema exists to expose.
test('subcommands are emitted with their full path', async () => {
  const names = buildSchema(await realProgram()).commands.map(c => c.name);
  for (const p of ['anchor set', 'trace insight', 'trail replay', 'cache prune']) {
    assert.ok(names.includes(p), `missing ${p}`);
  }
});

// `trace` and `memory` run on their own AND host subcommands. Dropping the bare
// form would hide a working command.
test('a parent that is itself runnable appears alongside its children', async () => {
  const names = buildSchema(await realProgram()).commands.map(c => c.name);
  for (const p of ['trace', 'trace start', 'memory', 'memory load']) {
    assert.ok(names.includes(p), `missing ${p}`);
  }
});

test('chrome flag passthrough is declared where it exists', async () => {
  const schema = buildSchema(await realProgram());
  const pass = schema.commands.filter(c => c.passthrough).map(c => c.name).sort();
  assert.deepEqual(pass, ['drift', 'new', 'restart']);
});

// `trail capture` shipped as `capture <name> <name>` — commander registers the
// arg once from `.command('capture <name>')` and again from `.argument('<name>')`,
// so the documented single-name form died on "missing required argument". Nothing
// caught it because the duplicate is invisible in the source and smoke only ran
// `trail list`.
test('no command declares the same argument twice', async () => {
  for (const c of buildSchema(await realProgram()).commands) {
    const names = c.args.map(a => a.name);
    assert.equal(new Set(names).size, names.length, `${c.name}: ${names.join(' ')}`);
  }
});

test('args and options carry through from commander', async () => {
  const schema = buildSchema(await realProgram());
  const nav = schema.commands.find(c => c.name === 'nav');
  assert.ok(nav);
  assert.deepEqual(nav.args.map(a => [a.name, a.required]), [['url', true]]);

  const ls = schema.commands.find(c => c.name === 'ls');
  assert.ok(ls?.options.some(o => o.flags.includes('--flags')));
});
