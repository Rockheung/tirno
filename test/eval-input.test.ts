import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExpression } from '../src/commands/eval.js';

// `eval` 의 입력이 인자 전용이라 여러 줄 JS 는 셸 따옴표 지옥이었다 (#137).
// 여기서 증명하는 것은 **어디서 읽는가의 우선순위**이지 페이지에서의 실행이 아니다.

let tmp: string;
const stdin = (s: string) => () => Promise.resolve(s);
const never = () => Promise.reject(new Error('stdin must not be read here'));

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-eval-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function withFile(content: string): string {
  const p = path.join(tmp, 'collect.js');
  fs.writeFileSync(p, content);
  return p;
}

test('an argument still wins — the old path is untouched', async () => {
  assert.equal(await resolveExpression('document.title', undefined, never, true), 'document.title');
});

test('--file reads the file verbatim, quotes and newlines and all', async () => {
  const src = '(() => {\n  const s = `a "b" \'c\' $d`;\n  return s;\n})()\n';
  assert.equal(await resolveExpression(undefined, withFile(src), never, true), src);
});

test('"-" means stdin', async () => {
  assert.equal(await resolveExpression('-', undefined, stdin('1 + 1'), false), '1 + 1');
});

// `tirno eval < collect.js` 가 되게 한다 — 파이프가 있는데 인자가 없으면 읽을 것은
// 그것뿐이다. TTY 면 사용자가 그냥 인자를 빠뜨린 것이므로 매달리지 않고 안내한다.
test('a pipe with no argument is read; a tty with no argument is an error', async () => {
  assert.equal(await resolveExpression(undefined, undefined, stdin('2 + 2'), false), '2 + 2');
  await assert.rejects(
    () => resolveExpression(undefined, undefined, never, true),
    /Nothing to evaluate.*--file/s,
  );
});

test('argument and --file together is an error, not a silent winner', async () => {
  await assert.rejects(
    () => resolveExpression('x', withFile('y'), never, true),
    /not both/,
  );
});

test('a missing --file names the path and the errno', async () => {
  await assert.rejects(
    () => resolveExpression(undefined, path.join(tmp, 'gone.js'), never, true),
    /Cannot read --file .*gone\.js: ENOENT/,
  );
});

// 빈 입력을 그대로 페이지에 밀어 넣으면 `undefined` 가 돌아오고, 그것은 "빈 파일을
// 줬다" 가 아니라 "평가 결과가 undefined 다" 로 읽힌다.
test('an empty source says so instead of evaluating nothing', async () => {
  await assert.rejects(
    () => resolveExpression(undefined, withFile('\n  \n'), never, true),
    /was empty/,
  );
  await assert.rejects(() => resolveExpression('-', undefined, stdin(''), false), /was empty/);
});
