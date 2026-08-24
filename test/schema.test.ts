import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
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
    ['session', 'registerSessionCommands'], ['chrome', 'registerChromeCommands'],
    ['anchor', 'registerAnchorCommands'],
    ['nav', 'registerNavCommands'], ['inspect', 'registerInspectCommands'],
    ['input', 'registerInputCommands'], ['eval', 'registerEvalCommand'],
    ['net', 'registerNetCommands'],
    ['emulate', 'registerEmulateCommand'], ['permissions', 'registerPermissionCommands'],
    ['headers', 'registerHeaderCommands'],
    ['sw', 'registerSwCommands'],
    ['perf', 'registerPerfCommands'],
    ['multi', 'registerMultiCommands'], ['cache', 'registerCacheCommands'],
    ['cdp', 'registerCdpCommands'],
    ['record', 'registerRecordCommands'], ['replay', 'registerReplayCommand'],
    ['trail', 'registerTrailCommands'],
    ['stats', 'registerStatsCommand'], ['audit', 'registerAuditCommand'],
    ['screencast', 'registerScreencastCommands'], ['schema', 'registerSchemaCommand'], ['update', 'registerUpdateCommand'],
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

// Error messages tell people what to run next, and two of them named commands
// that do not exist (`trail start`, `trace stop --out <p>`). Nothing checks
// prose, so the only way these stay true is to compare them against the schema.
test('every "tirno <cmd>" in a message names a real command', async () => {
  // 별칭도 진짜 이름이다 — `tirno net ls` 는 사람이 실제로 치는 형태다.
  const names = new Set(buildSchema(await realProgram()).commands
    .flatMap(c => [c.name, ...(c.aliases ?? [])]));
  const srcDir = path.join(import.meta.dirname, '..', '..', 'src');

  const files: string[] = [];
  (function walkDir(d: string): void {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walkDir(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  })(srcDir);

  const bad: string[] = [];
  for (const file of files) {
    // Comments are stripped first: a quoted phrase in prose ("tirno killed an
    // unrelated app") is not a command anyone types. Only what reaches a user
    // — error messages, descriptions, printed hints — is checked.
    const text = fs.readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // Only quoted forms — a backtick or quote is what makes it a command someone
    // is meant to type, rather than the word "tirno" in a sentence.
    for (const m of text.matchAll(/[`'"]tirno ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
      // A second word that is an option or a placeholder means the command is
      // the first word alone.
      const two = m[2] && names.has(`${m[1]} ${m[2]}`) ? `${m[1]} ${m[2]}` : m[1];
      if (!names.has(two)) bad.push(`${path.basename(file)}: ${m[0].slice(1)}`);
    }
  }
  assert.deepEqual(bad, [], bad.join(' · '));
});
