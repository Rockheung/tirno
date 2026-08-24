import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryWithChromeFlags, sandboxHint } from '../src/core/launch-hint.js';
import { launchOrExplain } from '../src/core/chrome-launcher.js';

// chromium 이 stderr 로 "--no-sandbox 를 써봐라" 라고 하는데, 그것을 tirno 문법으로
// 옮기는 일은 사용자 몫이었다 (#134). 여기서 증명하는 것은 그 번역이 **실행된 명령줄
// 그대로에 플래그만 얹은, 복붙 가능한 한 줄** 이라는 것.

function argv(...rest: string[]): string[] {
  return ['/usr/bin/node', '/x/bin/tirno.js', ...rest];
}

const SANDBOX_STDERR =
  'FATAL:zygote_host_impl_linux.cc(128) No usable sandbox! If you are running on ' +
  'Ubuntu 23.10+ … you can try using --no-sandbox.';

test('adds a separator when the command had none', () => {
  assert.equal(
    retryWithChromeFlags(argv('new', 'smoke', 'https://example.com', '--headless'), ['--no-sandbox']),
    'tirno new smoke https://example.com --headless -- --no-sandbox',
  );
});

// 두 번째 `--` 를 열면 첫 번째 뒤의 플래그가 전부 그쪽 인자로 밀려 명령이 달라진다.
test('appends after an existing separator instead of opening a second one', () => {
  assert.equal(
    retryWithChromeFlags(argv('new', 'x', '--', '--proxy-server=http://p'), ['--no-sandbox']),
    'tirno new x -- --proxy-server=http://p --no-sandbox',
  );
});

test('does not repeat a flag that is already there', () => {
  assert.equal(
    retryWithChromeFlags(argv('new', 'x', '--', '--no-sandbox'), ['--no-sandbox']),
    'tirno new x -- --no-sandbox',
  );
});

test('quotes values a shell would split', () => {
  assert.equal(
    retryWithChromeFlags(argv('new', 'x', '--user-agent=tirno probe'), ['--no-sandbox']),
    `tirno new x '--user-agent=tirno probe' -- --no-sandbox`,
  );
});

test('the hint carries the whole failing command line', () => {
  const hint = sandboxHint(SANDBOX_STDERR, argv('new', 'smoke', '--headless', '--ephemeral'));
  assert.ok(hint);
  assert.match(hint, /tirno new smoke --headless --ephemeral -- --no-sandbox/);
});

// 아무 실패에나 --no-sandbox 를 권하면 조언이 아니라 소음이다.
test('a failure that is not about the sandbox gets no hint', () => {
  assert.equal(sandboxHint('spawn ENOENT', argv('new', 'x')), null);
});

test('the hint names the AppArmor route, not just the workaround', () => {
  const hint = sandboxHint(SANDBOX_STDERR, argv('new', 'x'));
  assert.match(hint!, /AppArmor/);
});

// 힌트를 만드는 것과 그것이 **실제 기동 실패에 붙는 것**은 다른 문제다. 붙는 자리가
// 빠지면 sandboxHint 의 테스트는 전부 통과하고 사용자만 예전 메시지를 본다.

test('a real launch failure comes back with the retry line appended', async () => {
  const err = await launchOrExplain(
    {},
    async () => { throw new Error(`Failed to launch the browser process\n${SANDBOX_STDERR}`); },
    argv('new', 'smoke', '--headless'),
  ).then(() => null, (e: Error) => e);

  assert.ok(err);
  assert.match(err.message, /Failed to launch the browser process/, 'chromium stderr must survive verbatim');
  assert.match(err.message, /tirno new smoke --headless -- --no-sandbox/);
});

test('an unrelated launch failure is passed through untouched', async () => {
  const original = 'spawn /nope/chrome ENOENT';
  const err = await launchOrExplain(
    {},
    async () => { throw new Error(original); },
    argv('new', 'x'),
  ).then(() => null, (e: Error) => e);
  assert.equal(err!.message, original);
});

test('a launch that works is not touched at all', async () => {
  const browser = { marker: true };
  assert.equal(await launchOrExplain({}, async () => browser, argv('new', 'x')), browser);
});
