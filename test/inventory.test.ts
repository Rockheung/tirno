import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLsofListeners,
  parseUserDataDir,
  classify,
  type Listener,
  type Observation,
} from '../src/core/inventory.js';

// plan-anchor-broker.md §4 — T1 (ownership, with the real 9222/OtherApp case as
// a fixture), T2 (ghost), T5 (legacy fixed-port session), T6 (ambiguous).

// ------------------------------------------------------------ lsof parsing

// captured from `lsof -nP -iTCP -sTCP:LISTEN -F pcnt` on this machine
const LSOF = [
  'p637',
  'cControlCenter',
  'f9',
  'tIPv4',
  'n*:7000',
  'f10',
  'tIPv6',
  'n*:7000',
  'p1285',
  'cOtherAgentApp',
  'f39',
  'tIPv4',
  'n127.0.0.1:9222',
  'p52317',
  'cGoogle Chrome',
  'f62',
  'tIPv4',
  'n127.0.0.1:59524',
].join('\n');

test('parses lsof -F process/file sets', () => {
  const listeners = parseLsofListeners(LSOF);
  assert.equal(listeners.length, 4);
  assert.deepEqual(listeners[2], {
    pid: 1285,
    command: 'OtherAgentApp',
    family: 'IPv4',
    address: '127.0.0.1',
    port: 9222,
  });
});

test('keeps command names containing spaces intact', () => {
  // the whole reason for -F: the human table truncates COMMAND to 9 chars, so
  // "Google Chrome" would be indistinguishable from any other "Google *"
  const chrome = parseLsofListeners(LSOF).find(l => l.pid === 52317);
  assert.equal(chrome?.command, 'Google Chrome');
});

test('parses IPv6 and wildcard addresses without losing the port', () => {
  const listeners = parseLsofListeners(
    ['p10', 'cthing', 'f3', 'tIPv6', 'n[::1]:9333', 'f4', 'tIPv6', 'n*:8080'].join('\n'),
  );
  assert.deepEqual(listeners.map(l => [l.address, l.port]), [['[::1]', 9333], ['*', 8080]]);
});

test('skips malformed or unusable lsof records', () => {
  const listeners = parseLsofListeners(
    [
      'pnotapid', 'cbroken', 'f1', 'tIPv4', 'n127.0.0.1:1234',  // unparseable pid
      'p11', 'cnofamily', 'f2', 'n127.0.0.1:2345',              // no tIPv4/tIPv6 line
      'p12', 'cbadport', 'f3', 'tIPv4', 'n127.0.0.1:notaport',
      'p13', 'cok', 'f4', 'tIPv4', 'n127.0.0.1:3456',
    ].join('\n'),
  );
  assert.deepEqual(listeners.map(l => l.pid), [13]);
});

test('empty lsof output yields no listeners', () => {
  assert.deepEqual(parseLsofListeners(''), []);
});

// -------------------------------------------------------- cmdline parsing

test('extracts --user-data-dir from a chrome command line', () => {
  const cmdline =
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ' +
    '--remote-debugging-port=0 --user-data-dir=/Users/me/.tirno/profiles/main ' +
    '--no-first-run about:blank';
  assert.equal(parseUserDataDir(cmdline), '/Users/me/.tirno/profiles/main');
});

test('extracts a --user-data-dir that ends the command line', () => {
  assert.equal(
    parseUserDataDir('/x/chrome --user-data-dir=/Users/me/.tirno/profiles/tail'),
    '/Users/me/.tirno/profiles/tail',
  );
});

test('keeps spaces inside a profile path', () => {
  assert.equal(
    parseUserDataDir('/x/chrome --user-data-dir=/Users/me/my profiles/a --no-first-run'),
    '/Users/me/my profiles/a',
  );
});

// #123: --extensions 는 --disable-extensions 를 빼서 about:blank 가 값에 바로 붙는다.
test('strips a trailing start-URL positional from --user-data-dir', () => {
  assert.equal(
    parseUserDataDir('/x/chrome --user-data-dir=/Users/me/.tirno/profiles/s about:blank'),
    '/Users/me/.tirno/profiles/s');
  assert.equal(
    parseUserDataDir('/x/chrome --user-data-dir=/Users/me/.tirno/profiles/s https://example.com/'),
    '/Users/me/.tirno/profiles/s');
});

// 경로 안의 공백은 트레일링 URL 이 아니므로 안 뗀다.
test('keeps a genuine space in the path even with a trailing URL', () => {
  assert.equal(
    parseUserDataDir('/x/chrome --user-data-dir=/Users/me/my profiles/a about:blank'),
    '/Users/me/my profiles/a');
});

test('returns null when there is no --user-data-dir', () => {
  assert.equal(parseUserDataDir('/Applications/OtherAgentApp.app/Contents/MacOS/OtherAgentApp'), null);
});

// ------------------------------------------------------------- classifying

const listener = (over: Partial<Listener> = {}): Listener => ({
  pid: 500,
  command: 'Google Chrome',
  family: 'IPv4',
  address: '127.0.0.1',
  port: 9222,
  ...over,
});

const obs = (over: Partial<Observation> = {}): Observation => ({
  resolvedPort: 9222,
  pidAlive: true,
  listeners: [listener()],
  runningUserDataDir: '/Users/me/.tirno/profiles/main',
  expectedUserDataDir: '/Users/me/.tirno/profiles/main',
  pid: 500,
  ...over,
});

test('ours requires all three facts to agree', () => {
  assert.equal(classify(obs()).ownership, 'ours');
});

// T1 — the actual incident: the ledger claimed port 9222 was tirno session
// "legacy-widget-session" (pid 68429); the real listener was OtherApp's
// Electron app holding a production DB proxy login tab.
test('T1: the 9222 / OtherAgentApp case is foreign, and says so', () => {
  const verdict = classify(obs({
    pid: 68429,
    pidAlive: false,
    listeners: [listener({ pid: 1285, command: 'OtherAgentApp' })],
  }));
  assert.equal(verdict.ownership, 'foreign');
  assert.match(verdict.reason, /OtherAgentApp/);
  assert.match(verdict.reason, /1285/);
});

test('T1b: same incident with the pid recycled onto a live process is still foreign', () => {
  // isAlive(pid) alone would have said "running" and connected here
  const verdict = classify(obs({
    pid: 68429,
    pidAlive: true,
    listeners: [listener({ pid: 1285, command: 'OtherAgentApp' })],
  }));
  assert.equal(verdict.ownership, 'foreign');
  assert.match(verdict.reason, /not by pid 68429/);
});

test('a live pid running a different profile is foreign', () => {
  const verdict = classify(obs({ runningUserDataDir: '/Users/me/.tirno/profiles/other' }));
  assert.equal(verdict.ownership, 'foreign');
  assert.match(verdict.reason, /profiles\/other/);
});

test('an unreadable command line fails closed, not open', () => {
  assert.equal(classify(obs({ runningUserDataDir: null })).ownership, 'foreign');
});

test('a live pid that holds no port is foreign, not ours', () => {
  assert.equal(classify(obs({ listeners: [] })).ownership, 'foreign');
});

// T2 — ledger entry with nothing behind it
test('T2: dead pid with no listener is a ghost', () => {
  const verdict = classify(obs({ pidAlive: false, listeners: [] }));
  assert.equal(verdict.ownership, 'ghost');
  assert.match(verdict.reason, /nothing listens/);
});

test('a session with no resolvable port is a ghost', () => {
  assert.equal(classify(obs({ resolvedPort: null, listeners: [] })).ownership, 'ghost');
});

// T6 — 2026-07-07: two chromes on one port (old on IPv4, new on IPv6)
test('T6: two distinct pids on one port is ambiguous, even if one of them is ours', () => {
  const verdict = classify(obs({
    listeners: [
      listener({ pid: 500, family: 'IPv4' }),
      listener({ pid: 900, family: 'IPv6', command: 'Google Chrome' }),
    ],
  }));
  assert.equal(verdict.ownership, 'ambiguous');
  assert.match(verdict.reason, /2 listeners/);
  assert.match(verdict.reason, /900/);
});

test('ambiguity is decided before liveness, so it can never be auto-acted on', () => {
  // a dead pid + two listeners must not fall through to ghost/foreign
  const verdict = classify(obs({
    pidAlive: false,
    listeners: [listener({ pid: 500 }), listener({ pid: 900, family: 'IPv6' })],
  }));
  assert.equal(verdict.ownership, 'ambiguous');
});

test('one process listening on both address families is not ambiguous', () => {
  const verdict = classify(obs({
    listeners: [listener({ family: 'IPv4' }), listener({ family: 'IPv6', address: '[::1]' })],
  }));
  assert.equal(verdict.ownership, 'ours');
});

// T5 — legacy fixed-port sessions predate DevToolsActivePort and must still work
test('T5: a legacy fixed-port session passes on the same three facts', () => {
  const verdict = classify(obs({
    resolvedPort: 9223,               // from meta.port; no DevToolsActivePort exists
    listeners: [listener({ port: 9223 })],
  }));
  assert.equal(verdict.ownership, 'ours');
});

// ephemeral sessions live in tmpdir, not ~/.tirno/profiles — fact 3 compares
// against the session's own recorded dir so they stay connectable
test('an ephemeral session outside ~/.tirno/profiles is still ours', () => {
  const dir = '/var/folders/xx/T/tirno-e-abc123';
  assert.equal(classify(obs({ runningUserDataDir: dir, expectedUserDataDir: dir })).ownership, 'ours');
});
