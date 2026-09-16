import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TirnoError, SessionNotFound, SessionNotOwned, ChromeNotRunning, ERROR_CODES, codeOf, type ErrorCode,
} from '../src/util/errors.js';
import { Command } from 'commander';
import { buildSchema } from '../src/core/schema.js';

// 실패가 전부 exit 1 + 산문이라, 재시도해도 되는 것과 안 되는 것을 문장 파싱으로 갈라야
// 했다 (#185). 이제 stderr 마지막 줄이 `code: <snake_case>` 고 --json 이면 stdout 한 줄이다.

test('하위 클래스는 저마다 고정 code 와 data 를 갖는다', () => {
  assert.equal(new SessionNotFound('x').code, 'session_not_found');
  assert.deepEqual(new SessionNotFound('x').data, { session: 'x' });
  assert.equal(new ChromeNotRunning('x', 7).code, 'session_ghost');
  const owned = new SessionNotOwned('x', 9222, 'why', 'foreign');
  assert.equal(owned.code, 'session_not_owned');
  assert.equal(owned.data?.ownership, 'foreign');
});

test('아무 에러나 code 를 읽을 수 있다 — TirnoError 가 아니면 error', () => {
  assert.equal(codeOf(new Error('x')), 'error');
  assert.equal(codeOf(new TirnoError('x', 'stale_ref')), 'stale_ref');
  assert.equal(codeOf('string'), 'error');
});

test('code 는 snake_case 고 전부 설명이 있다', () => {
  for (const [code, desc] of Object.entries(ERROR_CODES)) {
    assert.match(code, /^[a-z][a-z0-9_]*$/, code);
    assert.ok(desc.length > 10, `${code} 설명이 비었다`);
  }
});

test('schema 의 errors 가 같은 목록을 싣는다 — 두 정본이 아니다', () => {
  const program = new Command().name('tirno').description('t').version('0.0.0');
  const schema = buildSchema(program);
  const failure = schema.errors.find(e => e.kind === 'failure')!;
  assert.deepEqual(
    (failure.codes ?? []).map(c => c.code).sort(),
    (Object.keys(ERROR_CODES) as ErrorCode[]).sort(),
  );
});

// 실제 프로세스로 — fail() 은 process.exit 을 부르므로 in-process 로는 못 본다.
const BIN = path.join(import.meta.dirname, '..', '..', 'bin', 'tirno.js');
function runTirno(args: string[]): { status: number; stdout: string; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-codes-'));
  try {
    execFileSync('node', [BIN, ...args], { env: { ...process.env, TIRNO_DIR: dir }, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout: '', stderr: '' };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('stderr 마지막 줄이 code 다 — 산문은 그대로', { skip: !fs.existsSync(BIN) }, () => {
  const r = runTirno(['eval', '1', '-s', 'nope']);
  assert.equal(r.status, 1);
  const lines = r.stderr.trim().split('\n');
  assert.match(lines[0], /Session 'nope' not found/);
  assert.match(lines.at(-1)!, /^\s*code: session_not_found$/);
});

test('--json 이면 실패도 stdout 에 JSON 한 줄이다', { skip: !fs.existsSync(BIN) }, () => {
  const r = runTirno(['eval', '1', '-s', 'nope', '--json']);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout.trim());
  assert.deepEqual(parsed, { ok: false, code: 'session_not_found', message: "Session 'nope' not found", data: { session: 'nope' } });
  assert.equal(r.stderr.trim(), '', 'JSON 모드에서는 stderr 에 산문을 겹쳐 내지 않는다');
});

test('TIRNO_JSON=1 은 --json 이 없는 명령에도 통한다', { skip: !fs.existsSync(BIN) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-codes-'));
  try {
    execFileSync('node', [BIN, 'click', '@1', '-s', 'nope'], {
      env: { ...process.env, TIRNO_DIR: dir, TIRNO_JSON: '1' }, encoding: 'utf8', stdio: 'pipe',
    });
    assert.fail('exit 1 이어야 한다');
  } catch (e) {
    const err = e as { status: number; stdout: string };
    assert.equal(err.status, 1);
    assert.equal(JSON.parse(String(err.stdout).trim()).code, 'session_not_found');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
