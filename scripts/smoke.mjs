// tirno CLI 전수 스모크 — 실제 Chrome 하나 띄워 놓고 거의 모든 명령을 태운다.
//
// 유닛 테스트가 증명하는 것은 파서와 판정 로직이고, 여기서 증명하는 것은 명령이
// 실제로 도는가다. 그 둘 사이에 버그가 산다 — 이 하네스를 처음 돌렸을 때 96개 중
// 5개가 깨져 있었고 유닛은 전부 초록이었다.
//
// 실행: node scripts/smoke.mjs
//   CHROME=<path>        실행 파일 지정
//   CHROME_FLAGS="a b"   `--` 뒤로 넘길 chrome 플래그 (CI 컨테이너의 --no-sandbox 등)
//
// 네트워크가 필요하다 — audit(lighthouse)은 http(s) 만 받고, 히스토리 검사는
// 다른 출처를 한 번 거쳐야 한다. 그래서 example.com 을 쓴다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TIRNO = path.join(import.meta.dirname, '..', 'bin', 'tirno.js');
const PAGE = 'file://' + path.join(import.meta.dirname, 'fixtures', 'smoke-page.html');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-smoke-out-'));
const extraFlags = (process.env.CHROME_FLAGS ?? '').split(' ').filter(Boolean);
const chromeArgs = process.env.CHROME ? ['--executable-path', process.env.CHROME] : [];
// 세션을 여는 모든 자리에 같은 인자를 준다 — 하나라도 빠지면 CI 에서 그 세션만 죽는다.
const LAUNCH = ['--headless', ...chromeArgs, ...(extraFlags.length ? ['--', ...extraFlags] : [])];

const env = { ...process.env, TIRNO_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-smoke-')) };
const results = [];

function run(label, args, { timeout = 60_000, expectFail = false } = {}) {
  let exit = 0, out = '', err = '';
  const t0 = Date.now();
  try {
    out = execFileSync('node', [TIRNO, ...args], {
      env, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    exit = e.status ?? (e.killed ? 'TIMEOUT' : 1);
    out = String(e.stdout ?? '');
    err = String(e.stderr ?? e.message ?? '');
  }
  const ms = Date.now() - t0;
  const first = (out + err).trim().split('\n').filter(Boolean)[0] ?? '';
  const ok = expectFail ? exit !== 0 : exit === 0;
  results.push({ label, cmd: args.join(' '), exit, ms, ok, note: first.slice(0, 110) });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
  return { exit, out, err };
}

const S = ['-s', 'smoke'];

// ── 세션
run('new (headless, ephemeral, bootUrl)', ['new', 'smoke', '--ephemeral', PAGE, ...LAUNCH]);
run('ls', ['ls']);
run('ls --json', ['ls', '--json']);
run('ls --flags', ['ls', '--flags']);
run('export', ['export', 'smoke']);
run('attach', ['attach', 'smoke']);
run('drift', ['drift', 'smoke']);
run('drift --all', ['drift', 'smoke', '--all']);

// ── 탐색
run('nav', ['nav', PAGE, ...S]);
run('reload', ['reload', ...S]);
run('reload --hard', ['reload', '--hard', ...S]);
run('pages', ['pages', ...S]);
run('pages --json', ['pages', '--json', ...S]);
const tab = run('new-tab', ['new-tab', 'about:blank', ...S]);
const pagesOut = run('pages (after new-tab)', ['pages', '--json', ...S]).out;
// 안정 핸들이므로 "지금 about:blank 인 탭"을 이름으로 골라 닫는다.
let blankId = '';
try { blankId = JSON.parse(pagesOut).find(p => p.url === 'about:blank')?.id ?? ''; } catch { /* ignore */ }
if (blankId !== '') {
  run('select', ['select', blankId, ...S]);
  run('close-tab', ['close-tab', blankId, ...S]);
} else {
  results.push({ label: 'select / close-tab', cmd: '-', exit: '-', ms: 0, ok: false, note: 'pages --json 에서 about:blank 탭을 못 찾음' });
}
// back/forward 를 태우려면 히스토리 항목이 둘 이상이어야 한다. 같은 URL 로 nav 하면
// 항목이 안 늘어나므로(실측: history.length 가 1로 고정) 다른 URL 을 한 번 거친다.
run('nav (다른 URL)', ['nav', 'https://example.com', ...S]);
run('nav (back to page)', ['nav', PAGE, ...S]);
run('back', ['back', ...S]);
run('forward', ['forward', ...S]);

// ── 조사
run('screenshot', ['screenshot', '--out', `${OUT}/s.png`, ...S]);
run('screenshot --full', ['screenshot', '--full', '--out', `${OUT}/full.png`, ...S]);
run('snapshot', ['snapshot', ...S]);
run('snapshot --verbose', ['snapshot', '--verbose', ...S]);
run('console', ['console', ...S]);
run('console --reload', ['console', '--reload', ...S]);
run('console --show 0', ['console', '--reload', '--show', '0', ...S]);
run('network', ['network', ...S]);
run('network --json', ['network', '--json', ...S]);

// ── 입력
run('eval', ['eval', 'document.title', ...S]);
run('click (selector)', ['click', '#btn', ...S]);
run('eval (클릭 반영 확인)', ['eval', "document.getElementById('status').textContent", ...S]);
run('click (coords)', ['click', '100,100', ...S]);
run('hover', ['hover', '#link', ...S]);
run('fill', ['fill', '#text', 'hello', ...S]);
run('fill --batch', ['fill', '--batch', '[{"target":"#text","value":"a"},{"target":"#area","value":"b"}]', ...S]);
run('type', ['type', 'typed', ...S]);
run('press', ['press', 'Tab', ...S]);
run('drag', ['drag', '#box', '#head', ...S]);
run('scroll', ['scroll', 'down', ...S]);
run('wait', ['wait', '100']);
run('wait-for (selector)', ['wait-for', '#bottom', '--timeout', '5000', ...S]);
run('wait-for --text', ['wait-for', '--text', 'bottom marker', '--timeout', '5000', ...S]);
run('wait-for --network-idle', ['wait-for', '--network-idle', '--timeout', '5000', ...S]);
fs.writeFileSync(`${OUT}/upload.txt`, 'x');
run('upload', ['upload', '#file', `${OUT}/upload.txt`, ...S]);

// ── 에뮬레이션
run('emulate --viewport', ['emulate', '--viewport', '1280x720', ...S]);
run('emulate --network', ['emulate', '--network', 'slow-3g', ...S]);
run('emulate --cpu', ['emulate', '--cpu', '2', ...S]);
run('emulate --dpr', ['emulate', '--dpr', '2', ...S]);
run('emulate --user-agent', ['emulate', '--user-agent', 'tirno-smoke', ...S]);
run('emulate --color-scheme', ['emulate', '--color-scheme', 'dark', ...S]);
run('emulate --geolocation', ['emulate', '--geolocation', '37.5,127.0', ...S]);
run('emulate --device', ['emulate', '--device', 'iPhone 14', ...S]);
run('emulate --list-devices', ['emulate', '--list-devices']);
run('emulate --reset', ['emulate', '--reset', ...S]);

// ── 성능/메모리
run('trace', ['trace', '--duration', '2', '--out', `${OUT}/t.json`, ...S], { timeout: 120_000 });
run('trace insight', ['trace', 'insight', `${OUT}/t.json`]);
run('trace start', ['trace', 'start', `${OUT}/t2.json`, ...S], { timeout: 120_000 });
run('trace stop', ['trace', 'stop', `${OUT}/t2.json`], { timeout: 120_000 });
run('memory', ['memory', '--out', `${OUT}/h.heapsnapshot`, ...S], { timeout: 120_000 });
run('memory load', ['memory', 'load', `${OUT}/h.heapsnapshot`], { timeout: 120_000 });
run('memory details', ['memory', 'details', `${OUT}/h.heapsnapshot`, '--page-size', '5'], { timeout: 120_000 });

// ── cdp
run('cdp', ['cdp', 'Runtime.evaluate', '{"expression":"1+1","returnByValue":true}', ...S]);
run('cdp --browser', ['cdp', '--browser', 'Browser.getVersion', ...S]);

// ── cache / vision
run('cache list', ['cache', 'list']);
run('cache load', ['cache', 'load', PAGE]);
run('cache prune --older-than', ['cache', 'prune', '--older-than', '0']);
run('vision ocr', ['vision', 'ocr', ...S], { timeout: 180_000 });

// ── record / replay / trail
run('record start', ['record', 'start', ...S]);
run('record stop', ['record', 'stop', '--save', 'smokerec', ...S]);
run('record list', ['record', 'list']);
run('replay', ['replay', 'smokerec', ...S], { timeout: 120_000 });
run('record rm', ['record', 'rm', 'smokerec']);
run('trail list', ['trail', 'list']);

// ── 지능 (키 없음 — 깨끗한 실패를 기대)
run('auth status', ['auth', 'status']);
run('ask (키 없음 → 실패 기대)', ['ask', 'find the button', ...S], { timeout: 60_000, expectFail: true });
run('explore (키 없음 → 실패 기대)', ['explore', 'click the button', '--max-steps', '1', ...S], { timeout: 60_000, expectFail: true });

// ── 앵커 / gc / 통계
run('anchor set', ['anchor', 'set', 'smokeanchor', 'smoke']);
run('anchor ls', ['anchor', 'ls']);
run('anchor ls --json', ['anchor', 'ls', '--json']);
run('anchor rm', ['anchor', 'rm', 'smokeanchor']);
run('gc --dry-run', ['gc', '--dry-run']);
run('stats', ['stats']);

// ── 멀티세션
run('new (2번째 세션)', ['new', 'smoke2', '--ephemeral', PAGE, ...LAUNCH]);
run('diff', ['diff', 'smoke', 'smoke2', '--out', `${OUT}/diff.png`], { timeout: 120_000 });
run('broadcast', ['broadcast', 'eval', 'document.title'], { timeout: 120_000 });
run('kill smoke2', ['kill', 'smoke2', '--clean']);

// ── screencast
run('screencast start', ['screencast', 'start', '--out', `${OUT}/cast`, ...S]);
run('screencast stop', ['screencast', 'stop', '--out', `${OUT}/cast`], { timeout: 120_000 });

// ── audit (lighthouse — 느림)
run('audit (https)', ['audit', 'https://example.com', '--out', `${OUT}/lh.html`, '--json', `${OUT}/lh.json`, '--quiet', ...S], { timeout: 300_000 });

// ── 세션 마무리
run('rename', ['rename', 'smoke', 'smoke-renamed']);
run('restart', ['restart', 'smoke-renamed', PAGE, ...LAUNCH], { timeout: 120_000 });
run('kill --clean', ['kill', 'smoke-renamed', '--clean']);

// ── 레거시 고정 포트 경로
run('new --port (레거시)', ['new', 'smokefixed', '--ephemeral', '--port', '9411', ...LAUNCH]);
run('ls (고정 포트 세션)', ['ls']);
run('eval (고정 포트 세션)', ['eval', '1+1', '-s', 'smokefixed']);
run('kill (고정 포트 세션)', ['kill', 'smokefixed', '--clean']);

fs.rmSync(env.TIRNO_DIR, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });

const bad = results.filter(r => !r.ok);
console.log(`\n총 ${results.length}건 · 통과 ${results.length - bad.length} · 실패 ${bad.length}`);
for (const r of bad) console.log(`  FAIL  ${r.label}  [exit ${r.exit}]  ${r.note}`);
process.exit(bad.length === 0 ? 0 : 1);
