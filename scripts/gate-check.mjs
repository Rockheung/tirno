// Gate 회귀 — 유닛 테스트가 증명하지 못하는 것만 본다: 진짜 Chrome 의 행동.
//
// 유닛은 캡처한 문자열로 파서와 판정을 증명한다. Chrome 이 DevToolsActivePort 를
// 아예 안 쓰게 바뀌어도 유닛은 전부 초록인 채 런타임만 죽는다. 여기가 그걸 잡는다.
//
// 실행: node scripts/gate-check.mjs
//   CHROME=<path>         실행 파일 지정 (미지정 시 tirno 의 기본 탐색)
//   CHROME_FLAGS="a b"    `--` 뒤로 넘길 chrome 플래그 (CI 컨테이너의 --no-sandbox 등)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TIRNO = path.join(import.meta.dirname, '..', 'bin', 'tirno.js');
const SESSION = 'gate-check';
const env = {
  ...process.env,
  TIRNO_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-gate-')),
};
const chromeArgs = process.env.CHROME ? ['--executable-path', process.env.CHROME] : [];
const extraFlags = (process.env.CHROME_FLAGS ?? '').split(' ').filter(Boolean);
const launchArgs = ['--headless', ...chromeArgs, ...(extraFlags.length ? ['--', ...extraFlags] : [])];

let failures = 0;

function check(label, fn) {
  try {
    const detail = fn();
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label} — ${e.message}`);
  }
}

function tirno(...args) {
  try {
    // stderr 는 캡처한다 — 기본값은 부모로 흘려보내는 것이라, 아래에서 이유를
    // 다시 찍으면 같은 줄이 두 번 나오고 정리 단계의 에러까지 로그에 샌다.
    return execFileSync('node', [TIRNO, ...args], {
      env,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // An execFileSync failure stringifies as the whole result object — pid, status,
    // signal, buffers — and buries the one line that says why. Keep that line.
    const reason = String(e.stderr || e.stdout || '').trim().split('\n').filter(Boolean).pop();
    throw new Error(`\`tirno ${args.join(' ')}\` 실패: ${reason || e.message}`);
  }
}

function meta() {
  return JSON.parse(tirno('export', SESSION));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let phase = '';
function gate(title) {
  phase = title.split(' —')[0];
  console.log(title);
}

try {
  gate('gate 1 — port 0 으로 띄우면 chrome 이 DevToolsActivePort 를 쓴다');
  const started = Date.now();
  tirno('new', SESSION, ...launchArgs);
  const elapsed = Date.now() - started;
  const first = meta();

  check('tirno new 이 반환한다', () => {
    assert(elapsed < 60_000, `${elapsed}ms 걸렸다`);
    return `${elapsed}ms`;
  });
  check('DevToolsActivePort 가 프로필에 있다', () => {
    const p = path.join(first.userDataDir, 'DevToolsActivePort');
    assert(fs.existsSync(p), `${p} 없음`);
    return fs.readFileSync(p, 'utf8').split('\n')[0];
  });
  check('그 포트가 실제로 서비스된다', () => {
    const v = execFileSync('curl', ['-s', '--max-time', '10', `http://127.0.0.1:${first.port}/json/version`], { encoding: 'utf8' });
    assert(v.includes('Browser'), `/json/version 응답이 이상하다: ${v.slice(0, 120)}`);
    return JSON.parse(v).Browser;
  });
  check('소유권 판정이 ours 다', () => {
    const row = tirno('ls').split('\n').find(l => l.includes(SESSION)) ?? '';
    assert(/\bours\b/.test(row), `OWNER 가 ours 가 아니다: ${row.trim()}`);
  });
  check('그 브라우저에 실제로 붙어서 동작한다', () => {
    const out = tirno('eval', '1 + 1');
    assert(out.includes('2'), `eval 결과가 이상하다: ${out.trim()}`);
  });

  gate('gate 2 — 재기동하면 새 포트를 잡고 파일이 갱신된다');
  tirno('restart', SESSION, ...launchArgs);
  const second = meta();

  check('포트가 바뀐다', () => {
    assert(second.port !== first.port, `그대로다 (${first.port})`);
    return `${first.port} → ${second.port}`;
  });
  check('DevToolsActivePort 가 새 포트를 담는다', () => {
    const body = fs.readFileSync(path.join(second.userDataDir, 'DevToolsActivePort'), 'utf8');
    assert(body.startsWith(String(second.port)), `파일=${body.split('\n')[0]} meta=${second.port}`);
  });
  check('재기동 후에도 ours 다', () => {
    const row = tirno('ls').split('\n').find(l => l.includes(SESSION)) ?? '';
    assert(/\bours\b/.test(row), `OWNER 가 ours 가 아니다: ${row.trim()}`);
  });
} catch (e) {
  // check() 밖에서 터진 것 — 대개 launch 자체가 실패한 경우다. 스택을 그대로
  // 흘리면 CI 로그에서 이유가 객체 덤프에 묻히므로 항목과 같은 모양으로 찍는다.
  failures++;
  console.log(`  FAIL  ${phase} 중단 — ${e.message}`);
} finally {
  try { tirno('kill', SESSION, '--clean'); } catch { /* 이미 없으면 그만 */ }
  fs.rmSync(env.TIRNO_DIR, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n전부 통과' : `\n${failures}건 실패`);
process.exit(failures === 0 ? 0 : 1);
