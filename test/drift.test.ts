import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseFlags } from '../src/core/inventory.js';
import { diffFlags, shellQuoteFlag, stripPositionals } from '../src/core/drift.js';

// plan-anchor-broker.md §3 Stage 5 — declared flags vs the running process.

// a real chrome command line as puppeteer launches it: tirno's flags, a start
// URL in the middle, and puppeteer's own defaults around them
const RUNNING =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ' +
  '--disable-background-networking --disable-sync ' +
  '--user-data-dir=/Users/me/.tirno/profiles/main --disable-extensions about:blank ' +
  '--remote-debugging-port=0 --no-first-run --no-default-browser-check ' +
  '--window-size=1920,1080 --window-position=0,0 ' +
  '--host-resolver-rules=MAP example.com 127.0.0.1';

// ------------------------------------------------------------- parseFlags

test('parses valued and valueless flags off a chrome command line', () => {
  const flags = parseFlags(RUNNING);
  assert.equal(flags.get('--window-size'), '1920,1080');
  assert.equal(flags.get('--no-first-run'), null);
  assert.equal(flags.get('--remote-debugging-port'), '0');
});

test('keeps a flag value that contains spaces', () => {
  assert.equal(parseFlags(RUNNING).get('--host-resolver-rules'), 'MAP example.com 127.0.0.1');
});

test('a positional after a valueless flag is not swallowed as its value', () => {
  const flags = parseFlags(RUNNING);
  assert.equal(flags.get('--disable-extensions'), null);
  assert.equal(flags.has('about:blank'), false);
});

test('the executable path is not mistaken for a flag', () => {
  assert.equal([...parseFlags(RUNNING).keys()].every(k => k.startsWith('--')), true);
});

test('an empty value stays distinct from no value', () => {
  const flags = parseFlags('/x/chrome --proxy-server= --headless');
  assert.equal(flags.get('--proxy-server'), '');
  assert.equal(flags.get('--headless'), null);
});

// -------------------------------------------------------------- diffFlags

test('no drift when everything declared is running as declared', () => {
  const report = diffFlags(
    ['--remote-debugging-port=0', '--no-first-run', '--window-size=1920,1080'],
    parseFlags(RUNNING),
  );
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.changed, []);
  assert.equal(report.hasDrift, false);
});

test('a declared flag the process does not have is reported missing', () => {
  const report = diffFlags(['--proxy-server=http://127.0.0.1:8080'], parseFlags(RUNNING));
  assert.deepEqual(report.missing, [
    { flag: '--proxy-server', expected: 'http://127.0.0.1:8080', actual: null },
  ]);
  assert.equal(report.hasDrift, true);
});

// the case Stage 5 exists for: routing config changed, chrome still has the old
// snapshot because it only reads these at launch
test('a changed --host-resolver-rules is reported with both values', () => {
  const report = diffFlags(['--host-resolver-rules=MAP example.com 10.0.0.1'], parseFlags(RUNNING));
  assert.deepEqual(report.changed, [{
    flag: '--host-resolver-rules',
    expected: 'MAP example.com 10.0.0.1',
    actual: 'MAP example.com 127.0.0.1',
  }]);
  assert.equal(report.hasDrift, true);
});

test('extra flags the process carries are not reported as drift', () => {
  // puppeteer adds --disable-sync, --disable-background-networking and friends;
  // treating those as defects would bury the signals that matter
  const report = diffFlags(['--no-first-run'], parseFlags(RUNNING));
  assert.equal(report.hasDrift, false);
});

test('start URLs and other positionals in the declared flags are ignored', () => {
  const report = diffFlags(['--no-first-run', 'https://example.com'], parseFlags(RUNNING));
  assert.equal(report.hasDrift, false);
});

test('valueless declared vs valued running counts as changed', () => {
  const report = diffFlags(['--window-size'], parseFlags(RUNNING));
  assert.deepEqual(report.changed, [{ flag: '--window-size', expected: null, actual: '1920,1080' }]);
});

test('nothing declared means nothing to drift from', () => {
  assert.equal(diffFlags([], parseFlags(RUNNING)).hasDrift, false);
});

// ------------------------------------------------- restart suggestion quoting

test('a plain flag is suggested unquoted', () => {
  assert.equal(shellQuoteFlag('--no-first-run'), '--no-first-run');
  assert.equal(shellQuoteFlag('--window-size=1920,1080'), '--window-size=1920,1080');
});

test('a value with spaces is quoted so the suggestion survives a paste', () => {
  assert.equal(
    shellQuoteFlag('--host-resolver-rules=MAP example.com 127.0.0.1'),
    `--host-resolver-rules='MAP example.com 127.0.0.1'`,
  );
});

test('quoting round-trips through a shell for values with spaces', () => {
  // the point of quoting: one argument out, not three
  const quoted = shellQuoteFlag('--host-resolver-rules=MAP a.com 1.2.3.4');
  const out = execFileSync('sh', ['-c', `printf '%s\\n' ${quoted}`], { encoding: 'utf8' });
  assert.equal(out, '--host-resolver-rules=MAP a.com 1.2.3.4\n');
});

test('an embedded single quote does not break out of the quoting', () => {
  const quoted = shellQuoteFlag(`--proxy-bypass-list=a'b c`);
  const out = execFileSync('sh', ['-c', `printf '%s\\n' ${quoted}`], { encoding: 'utf8' });
  assert.equal(out, `--proxy-bypass-list=a'b c\n`);
});

// ------------------------------------------------ start URLs vs flag values

test('a start URL does not glue itself onto the preceding flag', () => {
  const cmdline = '/x/chrome --window-size=1920,1080 --window-position=0,0 file:///tmp/page.html';
  const declared = ['--window-size=1920,1080', '--window-position=0,0', 'file:///tmp/page.html'];
  const flags = parseFlags(stripPositionals(cmdline, declared));
  assert.equal(flags.get('--window-position'), '0,0');
  assert.equal(diffFlags(declared, flags).hasDrift, false);
});

test('a value that legitimately contains spaces survives', () => {
  const cmdline = '/x/chrome --host-resolver-rules=MAP example.com 127.0.0.1 https://example.com';
  const declared = ['--host-resolver-rules=MAP example.com 127.0.0.1', 'https://example.com'];
  const flags = parseFlags(stripPositionals(cmdline, declared));
  assert.equal(flags.get('--host-resolver-rules'), 'MAP example.com 127.0.0.1');
  assert.equal(diffFlags(declared, flags).hasDrift, false);
});

test('no positionals declared — the command line is untouched', () => {
  const cmdline = '/x/chrome --headless --window-size=800,600';
  assert.equal(stripPositionals(cmdline, ['--headless', '--window-size=800,600']), cmdline);
});

test('real drift is still reported when a start URL is present', () => {
  const cmdline = '/x/chrome --window-size=800,600 https://example.com';
  const declared = ['--window-size=1920,1080', 'https://example.com'];
  const report = diffFlags(declared, parseFlags(stripPositionals(cmdline, declared)));
  assert.equal(report.hasDrift, true);
  assert.deepEqual(report.changed[0], { flag: '--window-size', expected: '1920,1080', actual: '800,600' });
});
