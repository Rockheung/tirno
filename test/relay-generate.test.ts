import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 배포 서버가 자산에 붙이던 헤더는 릴레이 경로에서만 살아남는다 — origin 응답을
// 그대로 넘기기 때문이다. 마운트한 경로는 응답을 이쪽이 만들므로 다시 선언해야 하고,
// 그것을 빠뜨리면 마운트한 것만 CORS 를 잃어 브라우저가 거부한다(#159).

const ROOT = path.join(import.meta.dirname, '..', '..');
const GEN = path.join(ROOT, 'plugins', 'tirno', 'skills', 'tirno-origin-relay', 'scripts', 'generate.mjs');

interface Run { ok: boolean; out: string; dir: string }

function run(mounts: unknown): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-relay-'));
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist', 'loader.mjs'), 'export const x = 1;');
  fs.writeFileSync(path.join(dir, 'mounts.json'), JSON.stringify({ origin: 'https://example.com', mounts }));
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir);
  // 인증서가 이미 있으면 다시 굽지 않는다 — openssl 을 테스트 전제로 만들지 않으려는 것.
  fs.writeFileSync(path.join(outDir, 'cert.pem'), 'x');
  fs.writeFileSync(path.join(outDir, 'key.pem'), 'x');
  try {
    execFileSync(process.execPath, [GEN, path.join(dir, 'mounts.json'), '--out', outDir], { stdio: 'pipe' });
    return { ok: true, out: fs.readFileSync(path.join(outDir, 'serve.mjs'), 'utf-8'), dir };
  } catch (e) {
    const err = e as { stderr?: Buffer };
    return { ok: false, out: err.stderr?.toString() ?? '', dir };
  }
}

function mapOf(serve: string): Record<string, { file: string; headers?: Record<string, string> }> {
  const start = serve.indexOf('const MAP = ') + 'const MAP = '.length;
  return JSON.parse(serve.slice(start, serve.indexOf('\n};', start) + 2));
}

test('마운트가 선언한 헤더가 그 경로의 응답 계획에 실린다', () => {
  const r = run([{ path: '/_/app/', root: './dist', headers: { 'access-control-allow-origin': '*' } }]);
  try {
    assert.ok(r.ok, r.out);
    const entry = mapOf(r.out)['/_/app/loader.mjs'];
    assert.deepEqual(entry?.headers, { 'access-control-allow-origin': '*' });
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('헤더를 선언하지 않은 마운트는 헤더 없이 나간다', () => {
  const r = run([{ path: '/_/app/', root: './dist' }]);
  try {
    assert.ok(r.ok, r.out);
    const entry = mapOf(r.out)['/_/app/loader.mjs'];
    assert.equal(entry?.headers, undefined);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

// 값이 문자열이 아니면 setHeader 가 런타임에 던진다. 굽는 자리에서 잡는 게 낫다.
test('헤더 값이 문자열이 아니면 생성이 거절한다', () => {
  const r = run([{ path: '/_/app/', root: './dist', headers: { 'x-num': 1 } }]);
  try {
    assert.equal(r.ok, false);
    assert.match(r.out, /headers 값은 문자열이어야 한다.*x-num/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('헤더가 객체가 아니면 생성이 거절한다', () => {
  const r = run([{ path: '/_/app/', root: './dist', headers: ['a'] }]);
  try {
    assert.equal(r.ok, false);
    assert.match(r.out, /headers 는 객체여야 한다/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

// 목록 밖은 origin 응답 헤더를 그대로 넘긴다 — 이번 변경이 건드리지 않아야 하는 쪽이다.
test('릴레이 경로는 origin 응답 헤더를 그대로 넘긴다', () => {
  const r = run([{ path: '/_/app/', root: './dist' }]);
  try {
    assert.ok(r.ok, r.out);
    assert.match(r.out, /res\.writeHead\(r\.statusCode, r\.headers\)/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

// ── WebSocket upgrade (#146).
//
// 'upgrade' 리스너가 없으면 그 요청은 평범한 HTTP 경로로 떨어지고, https.request 가
// origin 의 101 을 'response' 로 올리지 않으므로 아무것도 되돌려 쓰이지 않는다.
// 클라이언트는 핸드셰이크를 못 받고 매달리다 끊는데, 양쪽 다 에러를 안 낸다.
// 그래서 이 파일이 잠그는 것은 **핸들러가 붙어 있다**는 사실 자체다.

test('생성된 서버가 upgrade 를 받는다', () => {
  const r = run([{ path: '/_/app/', root: './dist' }]);
  try {
    assert.ok(r.ok, r.out);
    assert.match(r.out, /server\.on\('upgrade'/, 'upgrade 핸들러가 없다');
    // 두 핸들러가 같은 서버에 붙어야 한다 — 익명 createServer().listen() 이면
    // upgrade 를 걸 대상이 없다.
    assert.match(r.out, /const server = https\.createServer/);
    assert.match(r.out, /server\.listen\(/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('upgrade 릴레이는 tls 소켓을 직접 연다', () => {
  const r = run([{ path: '/_/app/', root: './dist' }]);
  try {
    assert.ok(r.ok, r.out);
    // https.request 로는 안 된다 — 101 이 'response' 로 안 올라온다.
    assert.match(r.out, /import tls from 'node:tls'/);
    assert.match(r.out, /tls\.connect\(/);
    assert.match(r.out, /up\.pipe\(socket\)/);
    assert.match(r.out, /socket\.pipe\(up\)/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

// 업그레이드를 파싱하며 이미 읽어 버린 첫 조각을 안 넘기면 첫 프레임이 사라진다 —
// 연결은 되는데 첫 메시지만 없는, 가장 알아보기 어려운 형태로 어긋난다.
test('upgrade 가 이미 읽은 첫 조각을 넘긴다', () => {
  const r = run([{ path: '/_/app/', root: './dist' }]);
  try {
    assert.ok(r.ok, r.out);
    assert.match(r.out, /if \(head && head\.length\) up\.write\(head\)/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

// Host 를 안 고치면 origin 의 가상호스팅이 이 요청을 못 알아본다. https 릴레이가
// 같은 이유로 같은 교정을 한다.
test('upgrade 도 Host 를 진짜 origin 으로 고친다', () => {
  const r = run([{ path: '/_/app/', root: './dist' }]);
  try {
    assert.ok(r.ok, r.out);
    assert.match(r.out, /\/\^host\$\/i\.test\(k\) \? u\.host :/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});
