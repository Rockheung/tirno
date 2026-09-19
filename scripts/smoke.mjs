// tirno CLI 전수 스모크 — 실제 Chrome 하나 띄워 놓고 거의 모든 명령을 태운다.
//
// 유닛 테스트가 증명하는 것은 파서와 판정 로직이고, 여기서 증명하는 것은 명령이
// 실제로 도는가다. 그 둘 사이에 버그가 산다 — 이 하네스를 처음 돌렸을 때 96개 중
// 5개가 깨져 있었고 유닛은 전부 초록이었다.
//
// 검사는 두 층이다: run() 은 "돌았다"(종료코드), check() 는 "맞게 돌았다"(출력 내용·
// 파일 생성·페이지 상태 변화). 종료코드만 보는 스모크는 broadcast 의 셸 결함처럼
// "명령은 존재하는데 문서대로 치면 죽는" 부류를 통과시킨다.
//
// 실행: node scripts/smoke.mjs
//   CHROME=<path>        실행 파일 지정
//   CHROME_FLAGS="a b"   `--` 뒤로 넘길 chrome 플래그 (CI 컨테이너의 --no-sandbox 등)
//
// 네트워크가 필요하다 — audit(lighthouse)은 http(s) 만 받고, 히스토리 검사는
// 다른 출처를 한 번 거쳐야 한다. 그래서 example.com 을 쓴다.
import { execFileSync, spawn } from 'node:child_process';
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

// 격리 — TIRNO_DIR 하나가 모든 저장소를 옮긴다. 그래도 저장소별 env 를 함께 거는
// 것은, 그 변수들이 루트보다 우선하기 때문이다 — 셸에 하나라도 걸려 있으면 스모크가
// 그쪽을 쓴다. 끝의 격리 검사가 실제 ~/.tirno 를 전후 비교해 이 전제를 지킨다.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-smoke-'));
const env = {
  ...process.env,
  TIRNO_DIR: ROOT,
  TIRNO_RECORDINGS_DIR: path.join(ROOT, 'recordings'),
  TIRNO_TRAILS_DIR: path.join(ROOT, 'trails'),
  TIRNO_CACHE_DIR: path.join(ROOT, 'visual-cache'),
  TIRNO_METRICS_FILE: path.join(ROOT, 'metrics.jsonl'),
};

const HOME_TIRNO = path.join(os.homedir(), '.tirno');
const results = [];

function run(label, args, { timeout = 60_000, expectFail = false, expectMatch, known } = {}) {
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
  let ok = expectFail ? exit !== 0 : exit === 0;
  let note = first.slice(0, 110);
  // 종료코드가 맞아도 약속한 문구가 없으면 실패 — "죽지 않았다"와 "말이 됐다"는 다르다.
  if (ok && expectMatch && !expectMatch.test(out + err)) {
    ok = false;
    note = `기대 문구 없음 ${expectMatch} · 실제: ${first.slice(0, 80)}`;
  }
  results.push({ label, cmd: args.join(' '), exit, ms, ok, known, note });
  process.stdout.write(`${ok ? 'ok  ' : known ? 'KNWN' : 'FAIL'} ${label}\n`);
  return { exit, out, err };
}

// 결과 검증 층 — run() 이 "돌았다"까지라면 여기는 "맞게 돌았다"를 본다.
function check(label, cond, note = '', { known } = {}) {
  const ok = !!cond;
  results.push({ label, cmd: '(verify)', exit: '-', ms: 0, ok, known, note: ok ? '' : note.slice(0, 160) });
  process.stdout.write(`${ok ? 'ok  ' : known ? 'KNWN' : 'FAIL'} ${label}\n`);
}

// 검증용 조용한 eval — 결과 목록을 어지럽히지 않는다. 실패하면 null.
function q(expr, session = 'smoke') {
  try {
    return execFileSync('node', [TIRNO, 'eval', expr, '-s', session], {
      env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

// PNG 는 IHDR 에 치수를 박아 둔다 — 파일이 존재하는 것과 그 크기로 찍힌 것은 다른 얘기다.
function pngSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

// 디렉터리도 항목으로 센다(뒤에 '/') — 빈 디렉터리 생성도 누출이다 (예: image-writer 의 ~/.tirno/tmp).
function lsTree(dir, prefix = '') {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of names) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.push(rel + '/');
      out.push(...lsTree(path.join(dir, d.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

// 메타 보존 검사에는 실존하는 chrome 경로가 필요하다. 못 찾으면 그 검사만 건너뛴다.
/**
 * 스모크가 쓸 chrome 경로. **tirno 자신에게 묻는다** — 여기에 탐색 목록을 한 벌 더
 * 두면 그쪽만 낡는다(실제로 그랬다: 이 목록에는 playwright 캐시도 /snap/bin 도 없어서
 * linux-arm64 에서 성립하는 경로가 0개였다, #133).
 */
function resolveChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  try {
    const out = execFileSync('node', [TIRNO, 'chrome', '--json'], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out).resolved?.path ?? null;
  } catch {
    return null;
  }
}

const CHROME_BIN = resolveChrome();

const homeBefore = new Set(lsTree(HOME_TIRNO));
const wallT0 = Date.now();
const S = ['-s', 'smoke'];

function main() {
  // ── 세션
  run('new (headless, ephemeral, bootUrl)', ['new', 'smoke', '--ephemeral', PAGE, ...LAUNCH]);
  run('ls', ['ls']);
  const lsJson = run('ls --json', ['ls', '--json']);
  // 장부에 있는 것과 프로세스를 소유한 것은 다르다 — ours 판정까지가 new 의 성공이다.
  let lsRow = null;
  try { lsRow = JSON.parse(lsJson.out).find(s => s.name === 'smoke') ?? null; } catch { /* ignore */ }
  check('ls --json (smoke 가 ours 로 잡힌다)', lsRow?.ownership === 'ours',
    `ownership=${lsRow?.ownership ?? '항목 없음'}`);
  // default viewport 1920x1080 은 CLAUDE.md 불변 — visual cache 의 viewport-key 정합성이 여기 걸려 있다.
  check('기본 뷰포트 1920x1080', q("innerWidth + 'x' + innerHeight") === '1920x1080',
    `실측: ${q("innerWidth + 'x' + innerHeight")}`);
  run('ls --flags', ['ls', '--flags']);
  const exp = run('export', ['export', 'smoke']);
  // export 는 사람 눈요기가 아니라 재사용 가능한 JSON 계약이다.
  let expJson = null;
  try { expJson = JSON.parse(exp.out); } catch { /* ignore */ }
  check('export 가 유효한 JSON (name·chromeFlags 포함)',
    expJson?.name === 'smoke' && Array.isArray(expJson?.chromeFlags),
    exp.out.slice(0, 80));
  run('attach', ['attach', 'smoke']);
  run('drift', ['drift', 'smoke']);
  run('drift --all', ['drift', 'smoke', '--all']);
  // drift 의 존재 이유는 다를 때 비정상 종료하는 것 — 늘 0 이면 아무것도 안 지킨다.
  run('drift (다른 플래그 → exit≠0)', ['drift', 'smoke', '--', '--flag-that-was-never-passed'], { expectFail: true });
  // 이름 충돌은 조용한 재사용이 아니라 거부 + --force 안내여야 한다.
  run('new (중복 이름 거부)', ['new', 'smoke', '--ephemeral', ...LAUNCH],
    { expectFail: true, expectMatch: /--force/ });

  // ── 탐색
  run('nav', ['nav', PAGE, ...S]);
  check('nav 가 실제로 그 URL 에 있다', q('location.href') === PAGE, `실측: ${q('location.href')}`);
  run('reload', ['reload', ...S]);
  // --hard 는 선언만 돼 있고 opts.hard 를 읽는 코드가 없었다. 이 검사가 지키는 것은
  // 딱 여기까지다 — 플래그가 받아들여지고 문서가 다시 적재된다. **캐시를 실제로
  // 우회했는지는 못 본다**: file:// 에는 캐시가 없고, https 로 재봐도 navigation
  // transferSize 는 일반 reload 와 갈리지 않았다(618/618/300, 원 서버 헤더에 좌우됨).
  // 우회 자체는 CDP 호출(Page.reload{ignoreCache:true})을 읽어 확인했다.
  execFileSync('node', [TIRNO, 'eval', 'window.__survives = 1', ...S], { env, stdio: 'ignore' });
  run('reload --hard', ['reload', '--hard', ...S], { expectMatch: /cache bypassed/ });
  check('reload --hard 가 문서를 다시 적재했다', q('typeof window.__survives') === 'undefined',
    `실측: ${q('typeof window.__survives')}`);
  run('pages', ['pages', ...S]);
  run('pages --json', ['pages', '--json', ...S]);
  run('new-tab', ['new-tab', 'about:blank', ...S]);
  const pagesOut = run('pages (after new-tab)', ['pages', '--json', ...S]).out;
  // 안정 핸들이므로 "지금 about:blank 인 탭"을 이름으로 골라 닫는다.
  let blankId = '', fixtureId = '';
  try {
    const pp = JSON.parse(pagesOut);
    blankId = pp.find(p => p.url === 'about:blank')?.id ?? '';
    fixtureId = pp.find(p => String(p.url).endsWith('smoke-page.html'))?.id ?? '';
  } catch { /* ignore */ }
  if (blankId !== '' && fixtureId !== '') {
    // new-tab 은 새 탭을 다음 명령의 대상으로 둔다 — 그래서 eval 이 about:blank 를 본다.
    // select 는 앞에 세우는 것에 더해 **이후 명령의 대상**을 바꾼다(#233): 탭이 둘일 때
    // eval 이 select 한 탭으로 가는지가 판정이고, visibilityState 는 앞에 섰다는 증거다.
    check('new-tab 뒤 eval 의 대상은 새 탭이다 (전제)', q('location.href') === 'about:blank', `실측: ${q('location.href')}`);
    run('select', ['select', fixtureId, ...S]);
    check('select 뒤 eval 의 대상이 그 탭이다 (#233)', String(q('location.href')).endsWith('smoke-page.html'), `실측: ${q('location.href')}`);
    check('select 가 대상 탭을 앞에 세웠다', q('document.visibilityState') === 'visible',
      `실측: ${q('document.visibilityState')}`);
    run('close-tab', ['close-tab', blankId, ...S]);
    let pagesAfter = null;
    try { pagesAfter = JSON.parse(run('pages (after close-tab)', ['pages', '--json', ...S]).out); } catch { /* ignore */ }
    check('close-tab 후 탭이 하나로 돌아왔다', pagesAfter?.length === 1, `탭 수: ${pagesAfter?.length}`);
  } else {
    results.push({ label: 'select / close-tab', cmd: '-', exit: '-', ms: 0, ok: false, note: 'pages --json 에서 about:blank 탭을 못 찾음' });
  }
  // back/forward 를 태우려면 히스토리 항목이 둘 이상이어야 한다. 같은 URL 로 nav 하면
  // 항목이 안 늘어나므로(실측: history.length 가 1로 고정) 다른 출처를 한 번 거친다.
  // 404 도 문서는 커밋된다 — exit 0 은 두되 조용하지는 않다. 상태 0 과 chrome-error 는 실패 (#189).
  const nf = run('nav 404 (exit 0 + 경고)', ['nav', 'https://example.com/tirno-smoke-404', ...S]);
  check('404 가 ⚠ non-2xx 경고를 낸다', /non-2xx/.test(nf.out) && /server said 404/.test(nf.out), nf.out.slice(0, 100));
  run('nav 404 --strict (→ exit≠0)', ['nav', 'https://example.com/tirno-smoke-404', '--strict', ...S],
    { expectFail: true, expectMatch: /strict: non-2xx/ });
  run('nav (다른 URL)', ['nav', 'https://example.com', ...S]);
  run('nav (back to page)', ['nav', PAGE, ...S]);
  run('back', ['back', ...S]);
  check('back 이 이전 항목으로 갔다', q('location.href') === 'https://example.com/', `실측: ${q('location.href')}`);
  run('forward', ['forward', ...S]);
  check('forward 가 다음 항목으로 갔다', q('location.href') === PAGE, `실측: ${q('location.href')}`);

  // ── 조사
  run('screenshot', ['screenshot', '--out', `${OUT}/s.png`, ...S]);
  // 파일 존재 ≠ 그 크기로 찍힘 — 뷰포트 스크린샷은 선언된 1920x1080 그대로여야 한다.
  const shot = pngSize(`${OUT}/s.png`);
  check('screenshot 이 1920x1080 PNG 다', shot?.w === 1920 && shot?.h === 1080, `실측: ${shot?.w}x${shot?.h}`);
  run('screenshot --full', ['screenshot', '--full', '--out', `${OUT}/full.png`, ...S]);
  // 픽스처는 2000px 넘게 길다 — full 이 뷰포트 높이에 머물면 --full 이 죽은 것이다.
  const full = pngSize(`${OUT}/full.png`);
  check('screenshot --full 이 뷰포트보다 길다', (full?.h ?? 0) > 1080, `실측 높이: ${full?.h}`);
  const snap = run('snapshot', ['snapshot', ...S]);
  // 출력 상한·경계·부분 트리 (#190). 잘림 표시 없는 잘림은 없다.
  const cut = run('snapshot --max-output 60', ['snapshot', '--max-output', '60', ...S]);
  check('잘렸으면 몇 줄 중 몇 줄인지 말한다', /truncated: showed \d+ of \d+ lines/.test(cut.out), cut.out.split('\n').slice(-3).join(' | ').slice(0, 120));
  const bounded = run('snapshot --content-boundaries', ['snapshot', '--content-boundaries', ...S]);
  check('경계 표식이 nonce 로 열고 닫힌다', (() => {
    const m = /begin ([0-9a-f]{6}) ---/.exec(bounded.out);
    return !!m && bounded.out.includes(`end ${m[1]} ---`);
  })(), bounded.out.slice(0, 80));
  const sub = run('snapshot --selector form', ['snapshot', '--selector', 'form', ...S]);
  check('부분 트리는 @1 부터 다시 매기고 밖은 안 낸다', /^@1  form/m.test(sub.out) && !/heading/.test(sub.out), sub.out.slice(0, 80));
  run('snapshot (전체로 복귀)', ['snapshot', ...S]);
  // 세션 뱃지 — headless 에선 기본 꺼지므로 별도 세션을 --badge 로 띄워 본다. 관측을
  // 더럽히지 않는 조건 셋(a11y · 스크린샷 · 레이아웃)과 끌기를 실제로 확인한다.
  run('new --badge (headless 강제)', ['new', 'badge', PAGE, '--ephemeral', '--badge', ...LAUNCH]);
  const B = ['-s', 'badge'];
  const qb = (expr) => q(expr, 'badge');
  check('뱃지가 붙어 있고 상단 가운데다', (() => {
    const v = JSON.parse(qb("(()=>{const h=document.getElementById('__tirno_badge');const r=h.getBoundingClientRect();return JSON.stringify([!!h,h.getAttribute('aria-hidden'),Math.abs((r.left+r.width/2)-innerWidth/2)<2,r.top])})()"));
    return v[0] && v[1] === 'true' && v[2] && v[3] === 8;
  })(), qb("(()=>{const h=document.getElementById('__tirno_badge');const r=h&&h.getBoundingClientRect();return h?JSON.stringify([r.left,r.top,r.width,innerWidth]):'no badge'})()"));
  const bs = run('snapshot (뱃지 세션)', ['snapshot', ...B]);
  check('a11y 트리에 뱃지가 없다', !/badge/.test(bs.out.replace(/tirno click/g, '')), bs.out.split('\n').find(l => /badge/.test(l) && !/tirno click/.test(l)) ?? '');
  run('screenshot (뱃지 숨김 후 복원)', ['screenshot', '--out', path.join(OUT, 'badge.png'), ...B]);
  check('스크린샷 뒤 뱃지가 다시 보인다', qb("getComputedStyle(document.getElementById('__tirno_badge')).visibility") === 'visible', qb("getComputedStyle(document.getElementById('__tirno_badge')).visibility"));
  // 끌기 — 뱃지 중심을 잡아 (+300, +200) 옮긴다. mouse 는 실제 Input 이벤트다.
  const before = JSON.parse(qb("(()=>{const r=document.getElementById('__tirno_badge').getBoundingClientRect();return JSON.stringify([r.left,r.top,r.width,r.height])})()"));
  const [bx, by] = [Math.round(before[0] + before[2] / 2), Math.round(before[1] + before[3] / 2)];
  run('drag 뱃지', ['drag', `${bx},${by}`, `${bx + 300},${by + 200}`, ...B]);
  const after = JSON.parse(qb("(()=>{const r=document.getElementById('__tirno_badge').getBoundingClientRect();return JSON.stringify([r.left,r.top])})()"));
  check('뱃지가 끌려갔다', Math.abs(after[0] - (before[0] + 300)) < 4 && Math.abs(after[1] - (before[1] + 200)) < 4, `before ${before} after ${after}`);
  run('kill (뱃지 세션)', ['kill', 'badge', '--clean']);
  run('attach smoke (뱃지 세션이 active 를 가져갔다)', ['attach', 'smoke']);
  // a11y 트리에 픽스처의 버튼이 보여야 스냅샷이 "내용을 본" 것이다.
  check('snapshot 에 버튼이 보인다', snap.out.includes('click me'), snap.out.slice(0, 80));
  const snapVerbose = run('snapshot --verbose', ['snapshot', '--verbose', ...S]);
  // 기본 출력은 InlineTextBox 복창과 빈 컨테이너를 접는다 — --verbose 보다 짧아야 하고,
  // 접었다는 사실을 말해야 한다. "이 페이지에 이것뿐" 과 구별되지 않으면 안 된다.
  check('snapshot 기본이 --verbose 보다 짧다',
    snap.out.split('\n').length < snapVerbose.out.split('\n').length,
    `실측: 기본 ${snap.out.split('\n').length}줄 / verbose ${snapVerbose.out.split('\n').length}줄`);
  check('snapshot 이 접은 줄 수를 밝힌다', /line\(s\) folded/.test(snap.out), snap.out.split('\n').at(-2) ?? '');
  // 끝줄의 접힘 요약에는 그 단어가 들어간다 — 트리 줄만 본다.
  const snapTree = snap.out.split('\n').filter(l => !l.startsWith('\u001b') && !l.includes('folded'));
  check('접힌 트리에 InlineTextBox 가 없다', !snapTree.join('\n').includes('InlineTextBox'),
    snapTree.find(l => l.includes('InlineTextBox')) ?? '');
  check('--verbose 에는 InlineTextBox 가 있다', snapVerbose.out.includes('InlineTextBox'));
  run('console', ['console', ...S]);
  // --reload 는 페이지 로드 시점의 로그를 다시 잡는 게 존재 이유다.
  run('console --reload', ['console', '--reload', ...S], { expectMatch: /smoke page loaded/ });
  run('console --show 0', ['console', '--reload', '--show', '0', ...S]);
  run('network', ['network', ...S]);
  // reload 는 현재 상태를 버린다 — 캐러셀을 넘겨둔 페이지에서 그것이 치명적이었다 (#136).
  run('click (상태 만들기)', ['click', '#btn', ...S]);
  run('network --no-reload', ['network', '--no-reload', '--ms', '300', ...S]);
  check('network --no-reload 가 페이지 상태를 지킨다',
    q("document.getElementById('status').textContent") === 'clicked',
    `실측: ${q("document.getElementById('status').textContent")}`);
  run('network (reload 는 상태를 버린다)', ['network', ...S]);
  check('network 는 리로드하므로 상태가 초기화된다',
    q("document.getElementById('status').textContent") === 'idle',
    `실측: ${q("document.getElementById('status').textContent")}`);
  const net = run('network --json', ['network', '--json', ...S]);
  let netRows = null;
  try { netRows = JSON.parse(net.out); } catch { /* ignore */ }
  check('network --json 에 문서 요청이 status 200 으로 잡힌다',
    Array.isArray(netRows) && netRows.some(r => String(r.url).endsWith('smoke-page.html') && r.status === 200),
    net.out.slice(0, 80));

  // net 은 reload 없이 **이미 받아둔 것**을 본다 — 그래서 여기서 증명할 것은 목록이
  // 나온다가 아니라 **바이트가 나온다** 이다. 픽스처의 dot.png 는 70바이트 PNG 다.
  const netLs = run('net ls --json', ['net', 'ls', '--json', ...S]);
  let resources = null;
  try { resources = JSON.parse(netLs.out); } catch { /* ignore */ }
  check('net ls 가 페이지의 이미지를 잡는다',
    Array.isArray(resources) && resources.some(r => String(r.url).endsWith('dot.png') && r.type === 'Image'),
    netLs.out.slice(0, 80));
  run('net ls --type --filter', ['net', 'ls', '--type', 'image', '--filter', '*.png', ...S]);
  const NETOUT = `${OUT}/net`;
  run('net save', ['net', 'save', '*.png', '--out', NETOUT, ...S], { expectMatch: /1 file\(s\)/ });
  const savedDot = path.join(NETOUT, 'dot.png');
  const dotBytes = fs.existsSync(savedDot) ? fs.readFileSync(savedDot) : Buffer.alloc(0);
  // PNG 시그니처까지 본다 — 파일이 생겼다와 그 파일이 그 응답이다는 다르다.
  check('net save 가 실제 응답 바이트를 썼다',
    dotBytes.length === 70 && dotBytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
    `실측: ${dotBytes.length}B ${dotBytes.subarray(0, 8).toString('hex')}`);
  run('net save (매치 없음 → exit≠0)', ['net', 'save', 'zzz-no-such', '--out', `${OUT}/net-none`, ...S],
    { expectFail: true });
  check('매치가 없으면 디렉터리도 안 만든다', !fs.existsSync(`${OUT}/net-none`));
  run('net save (--limit 초과 → exit≠0)', ['net', 'save', '--out', `${OUT}/net-limit`, '--limit', '0', ...S],
    { expectFail: true });

  // HAR 은 DevTools 가 읽는 계약이다 — 스펙을 어기면 에러가 아니라 빈 폭포가 된다.
  const HAR = `${OUT}/session.har`;
  run('net export --reload', ['net', 'export', '--out', HAR, '--reload', ...S]);
  let harDoc = null;
  try { harDoc = JSON.parse(fs.readFileSync(HAR, 'utf8')); } catch { /* ignore */ }
  const harEntries = harDoc?.log?.entries ?? [];
  check('HAR 이 1.2 봉투에 엔트리를 담는다',
    harDoc?.log?.version === '1.2' && harDoc?.log?.creator?.name === 'tirno' && harEntries.length > 0,
    `실측: ${harEntries.length} entries`);
  // time 이 구간의 합이 아니면 그 항목은 DevTools 에서 그려지지 않는다.
  const badTime = harEntries.find(e => {
    const known = [e.timings?.send, e.timings?.wait, e.timings?.receive].filter(n => n >= 0);
    const want = known.length ? Math.round(known.reduce((a, b) => a + b, 0) * 1000) / 1000 : -1;
    return Math.abs((e.time ?? 0) - want) > 0.01;
  });
  check('HAR 의 time 이 timings 의 합이다', !badTime, badTime ? JSON.stringify(badTime.timings) : '');
  // base64 본문의 size 는 디코드된 크기여야 한다 — 문자열 길이를 적으면 4/3 배로 틀린다.
  const b64 = harEntries.find(e => e.response?.content?.encoding === 'base64');
  check('HAR 의 base64 본문 size 가 디코드 크기다',
    !b64 || b64.response.content.size === Buffer.from(b64.response.content.text, 'base64').length,
    b64 ? `선언 ${b64.response.content.size}` : '(base64 본문 없음 — 픽스처는 png 하나뿐이다)');
  run('net export --no-bodies', ['net', 'export', '--out', `${OUT}/nobody.har`, '--no-bodies', '--reload', ...S]);
  let noBody = null;
  try { noBody = JSON.parse(fs.readFileSync(`${OUT}/nobody.har`, 'utf8')); } catch { /* ignore */ }
  check('--no-bodies 는 본문을 안 싣는다',
    (noBody?.log?.entries ?? []).every(e => !('text' in (e.response?.content ?? {}))));

  // ── 입력
  run('eval', ['eval', 'document.title', ...S]);
  // 이 인자는 공백·따옴표·괄호·유니코드를 전부 품는다 — 셸을 태우면 반드시 깨진다.
  run('eval (공백·따옴표·괄호·유니코드 인자)',
    ['eval', "['가','b c'].join(' + ') + ' (ok)'", ...S],
    { expectMatch: /가 \+ b c \(ok\)/ });

  // 여러 줄 JS 를 인자로 넘기는 것이 #137 의 통증이었다. 이 파일에는 셸 지뢰가 전부
  // 들어 있다 — 따옴표 두 종류, `$`, 백틱, 줄바꿈. 인자로 넣으면 반드시 깨진다.
  const JSFILE = path.join(OUT, 'collect.js');
  fs.writeFileSync(JSFILE, [
    '(() => {',
    '  const t = document.title;',
    '  const note = `${t} — "quoted" \'single\' $HOME`;',
    '  return { t, note };',
    '})()',
  ].join('\n'));
  run('eval --file', ['eval', '--file', JSFILE, ...S], { expectMatch: /\$HOME/ });
  run('eval --file (없는 파일 → exit≠0)', ['eval', '--file', `${OUT}/no-such.js`, ...S], { expectFail: true });
  // stdin 은 /dev/null 이라 비어 있다. 그대로 페이지에 밀어 넣으면 undefined 가 나오고,
  // 그것은 "빈 입력을 줬다" 가 아니라 "결과가 undefined 다" 로 읽힌다.
  run('eval (인자도 --file 도 없음 → exit≠0)', ['eval', ...S], { expectFail: true });
  run('eval (인자 + --file 동시 → exit≠0)', ['eval', '1', '--file', JSFILE, ...S], { expectFail: true });
  run('click (selector)', ['click', '#btn', ...S]);
  check('click 이 페이지 상태를 바꿨다', q("document.getElementById('status').textContent") === 'clicked');
  run('click (coords)', ['click', '100,100', ...S]);
  // 없는 셀렉터는 매달리지도, 조용히 넘어가지도 말아야 한다.
  run('click (없는 셀렉터 → exit≠0)', ['click', '#definitely-not-there', ...S],
    { expectFail: true, expectMatch: /No element/ });
  run('hover', ['hover', '#link', ...S]);
  check('hover 가 mouseover 를 실제로 쐈다', q("document.getElementById('status').textContent") === 'hovered');
  // hover 만 @ref 를 안 받았다 — click/fill 은 받는데. 표면이 갈리면 호출자가 분기해야 한다.
  // 포인터를 먼저 다른 곳으로 뗀다 — 같은 요소 위에 이미 있으면 mouseover 가 다시 뜨지
  // 않아, 검사가 hover 를 안 해도 통과하거나(옛 값) 해도 실패한다.
  execFileSync('node', [TIRNO, 'hover', '#text', ...S], { env, stdio: 'ignore' });
  q("document.getElementById('status').textContent = ''");
  // @ref 는 한 스냅샷 안에서만 안전하다. 그 경계를 도구가 지키는지 본다 (#138).
  const snapGen = run('snapshot (세대 확인)', ['snapshot', ...S]);
  const gen = Number((/generation (\d+)/.exec(snapGen.out) ?? [])[1]);
  check('snapshot 이 세대를 밝힌다', Number.isFinite(gen) && gen > 0, `실측: ${gen}`);
  const btnRef = (/@(\d+)[^\n]*button "click me"/.exec(snapGen.out) ?? [])[1];
  run('click @vG:N (맞는 세대)', ['click', `@v${gen}:${btnRef}`, ...S], { expectMatch: /Clicked/ });
  run('click @vG:N (틀린 세대 → exit≠0)', ['click', `@v${gen + 99}:${btnRef}`, ...S], { expectFail: true });
  // 같은 문서 안에서 DOM 만 갈아치운다 — loaderId 는 안 바뀌므로 요소 identity 로만 잡힌다.
  run('eval (DOM 교체)', ['eval', `document.querySelector('form').innerHTML = '<button id=x type=button>other</button>'`, ...S]);
  const stale = run('click @N (교체된 DOM → exit≠0)', ['click', `@${btnRef}`, ...S], { expectFail: true });
  check('거부 메시지가 무엇이 무엇으로 바뀌었는지 말한다',
    /was button "click me"/.test(stale.out + stale.err), (stale.out + stale.err).slice(0, 110));
  // --stale-ok 는 세대 검사만 건너뛴다. 교체된 노드는 문서에 없으므로 실제 마우스가 갈 곳이
  // 없다 — 예전 합성 click() 은 떨어진 노드의 핸들러를 돌리고 "Clicked" 를 찍었다 (#183).
  run('click --stale-ok (교체된 노드 → detached 로 exit≠0)', ['click', `@${btnRef}`, '--stale-ok', ...S],
    { expectFail: true, expectMatch: /no longer in the document/ });
  run('click --stale-ok --synthetic (알고도 진행)', ['click', `@${btnRef}`, '--stale-ok', '--synthetic', ...S], { expectMatch: /Clicked/ });
  run('reload (세대 무효화)', ['reload', ...S]);
  run('snapshot (새 세대)', ['snapshot', ...S]);

  const snapForHover = run('snapshot (hover @ref 용)', ['snapshot', ...S]);
  const linkRef = (/@(\d+)[^\n]*link/.exec(snapForHover.out) ?? [])[1];
  run('hover @ref', ['hover', `@${linkRef ?? 0}`, ...S], { expectMatch: /Hovered/ });
  check('hover @ref 가 mouseover 를 쐈다', q("document.getElementById('status').textContent") === 'hovered',
    `실측: ${q("document.getElementById('status').textContent")} (ref @${linkRef})`);
  // 레시피 (#211) — 기록 · 가림 · @N → role+이름 · 재생 · 실패 지점.
  run('recipe begin', ['recipe', 'begin', 'smoke-flow', '--var', 'TIRNO_SMOKE_SECRET', ...S], { expectMatch: /recording recipe/ });
  const secretEnv = { ...env, TIRNO_SMOKE_SECRET: 'sm0ke-secret' };
  execFileSync('node', [TIRNO, 'ensure', 'textbox', 'type here', '=', 'sm0ke-secret', ...S], { env: secretEnv, encoding: 'utf8', stdio: 'pipe' });
  const snapR = run('snapshot (recipe 용)', ['snapshot', ...S]);
  const btnR = (/@(\d+)[^\n]*button "click me"/.exec(snapR.out) ?? [])[1];
  run('click @N (기록 중)', ['click', `@${btnR ?? 0}`, ...S]);
  run('expect text clicked (기록 중)', ['expect', 'text', 'clicked', ...S]);
  run('click button "Nope" (실패 — 기록 안 됨)', ['click', 'button', 'Nope', ...S], { expectFail: true });
  run('recipe end', ['recipe', 'end', ...S], { expectMatch: /saved recipe "smoke-flow" \(3 steps\)/ });
  const shown = run('recipe show', ['recipe', 'show', 'smoke-flow']);
  check('@N 이 role+이름으로 적혔다', /click button click me/.test(shown.out) && /\(was @\d+\)/.test(shown.out), shown.out.slice(0, 200));
  check('비밀은 $VAR 로 적히고 값은 파일에 없다', /\$TIRNO_SMOKE_SECRET/.test(shown.out) && !/sm0ke-secret/.test(fs.readFileSync(path.join(ROOT, 'recipes', 'local', 'smoke-flow.json'), 'utf8')), shown.out.slice(0, 200));
  q("document.getElementById('text').value=''; document.getElementById('status').textContent='idle'");
  run('recipe run (변수 없이 → exit≠0)', ['recipe', 'run', 'smoke-flow', ...S], { expectFail: true, expectMatch: /recipe needs TIRNO_SMOKE_SECRET/ });
  const ran = run('recipe run', ['recipe', 'run', 'smoke-flow', 'TIRNO_SMOKE_SECRET=sm0ke-secret', ...S], { expectMatch: /3 steps ok/ });
  check('재생이 실제로 눌렀다', q("document.getElementById('status').textContent") === 'clicked');
  check('재생 출력에도 비밀이 없다', !/sm0ke-secret/.test(ran.out), ran.out.slice(0, 200));
  q("document.getElementById('btn').textContent='renamed'");
  run('recipe run --no-start-url (바뀐 페이지 → 단계 2 실패)', ['recipe', 'run', 'smoke-flow', 'TIRNO_SMOKE_SECRET=x', '--no-start-url', ...S], { expectFail: true, expectMatch: /step 2 failed[\s\S]*--from 2/ });
  q("document.getElementById('btn').textContent='click me'");
  run('recipe run --from 2', ['recipe', 'run', 'smoke-flow', 'TIRNO_SMOKE_SECRET=x', '--from', '2', '--no-start-url', ...S], { expectMatch: /2 steps ok/ });
  run('recipe ls', ['recipe', 'ls'], { expectMatch: /smoke-flow/ });
  run('recipe rm', ['recipe', 'rm', 'smoke-flow'], { expectMatch: /removed/ });
  q("document.getElementById('text').value=''; document.getElementById('status').textContent='idle'");
  // plan / apply (#212) — 실행 전 판정과 적용. 레시피와 같은 실행기.
  const PLAN = path.join(OUT, 'plan.json');
  fs.writeFileSync(PLAN, JSON.stringify({ vars: ['VAL'], steps: [
    'expect count button ge 2', 'click button "click me"', 'ensure textbox "type here" = $VAL', 'expect text clicked', 'click button "Nope"',
  ] }));
  const pj = run('plan (판정만)', ['plan', PLAN, 'VAL=x', ...S]);
  check('plan 이 있는 것·없는 것을 가른다', /click button click me\s+found on the page/.test(pj.out) && /click button Nope\s+NOT on the page/.test(pj.out), pj.out.slice(0, 300));
  check('plan 은 실행하지 않는다', q("document.getElementById('status').textContent") !== 'clicked');
  run('apply (단계 5 에서 멈춤)', ['apply', PLAN, 'VAL=plan-value', ...S], { expectFail: true, expectMatch: /step 5 failed[\s\S]*--from 5/ });
  check('apply 가 실제로 눌렀다', q("document.getElementById('status').textContent") === 'clicked');
  check('apply 가 값을 채웠다', q("document.getElementById('text').value") === 'plan-value');
  fs.writeFileSync(PLAN, JSON.stringify({ steps: ['expect text clicked'] }));
  run('apply (전부 ok)', ['apply', PLAN, ...S], { expectMatch: /1 step ok/ });
  q("document.getElementById('text').value=''; document.getElementById('status').textContent='idle'");
  // 목적별 관측 (#213)
  const si = run('snapshot --interactive', ['snapshot', '--interactive', ...S]);
  const siLines = si.out.split('\n').filter(l => /^@/.test(l));
  check('--interactive 는 조작 가능한 것만, 번호는 전체와 같다', siLines.some(l => /^@\d+ +button "click me"/.test(l)) && !siLines.some(l => /StaticText|heading|paragraph/.test(l)), si.out.slice(0, 160));
  const fo = run('forms', ['forms', ...S]);
  check('forms 가 라벨·값·플래그를 낸다', /type here\s+│\s+textbox/.test(fo.out) && /readonly/.test(fo.out) && /combobox\s+│\s+A ⟨A \| B⟩/.test(fo.out), fo.out.slice(0, 300));
  run('forms --json', ['forms', '--json', ...S], { expectMatch: /"label": "type here"/ });
  run('links', ['links', ...S], { expectMatch: /go to anchor/ });
  const tb = run('table --json', ['table', '#orders', '--json', ...S]);
  check('table 이 th 를 키로 행을 낸다', (() => { try { const r = JSON.parse(tb.out); return r[0].Item === 'Apple' && r[1].Qty === '1'; } catch { return false; } })(), tb.out.slice(0, 100));
  run('table --csv', ['table', '#orders', '--csv', ...S], { expectMatch: /Item,Qty\nApple,3/ });
  run('read', ['read', ...S], { expectMatch: /A paragraph of body text/ });
  const ex = run('explain button "click me"', ['explain', 'button', 'click me', ...S]);
  check('explain 이 selector·click 판정·cache 를 낸다', /selector\s+#btn/.test(ex.out) && /would land/.test(ex.out) && /cache\s+seen as @\d+/.test(ex.out), ex.out.slice(0, 300));
  q("document.getElementById('cover').classList.add('on')");
  run('explain (가려진 요소)', ['explain', '#under', ...S], { expectMatch: /covered by div#cover/ });
  q("document.getElementById('cover').classList.remove('on')");
  const wt = run('watch --for 1s --console', ['watch', '--for', '1s', '--console', ...S]);
  check('watch 가 NDJSON 으로 시작·끝을 낸다', /"type":"watch"/.test(wt.out) && /"type":"end"/.test(wt.out), wt.out.slice(0, 200));
  // 세션 정책 (#214) — read-only · confirm destructive · allow(두 층). 별도 세션으로.
  run('new --read-only', ['new', 'ro', PAGE, '--ephemeral', '--read-only', ...LAUNCH]);
  run('click (read-only → policy_denied)', ['click', 'button', 'click me', '-s', 'ro'], { expectFail: true, expectMatch: /read-only/ });
  run('eval (read-only → 거부)', ['eval', '1', '-s', 'ro'], { expectFail: true, expectMatch: /--allow-eval/ });
  run('eval --allow-eval', ['eval', '1', '--allow-eval', '-s', 'ro'], { expectMatch: /^1$/m });
  run('snapshot (read-only 는 관측 허용)', ['snapshot', '-s', 'ro']);
  check('ls 에 정책이 보인다', /read-only/.test(run('ls (policy)', ['ls']).out));
  run('kill ro', ['kill', 'ro', '--clean']);
  fs.writeFileSync(path.join(OUT, 'destr.html'), '<button onclick="this.textContent=\'GONE\'">Delete account</button><button>Save</button>');
  run('new --confirm destructive', ['new', 'cd', 'file://' + path.join(OUT, 'destr.html'), '--ephemeral', '--confirm', 'destructive', ...LAUNCH]);
  run('click 파괴적 이름 (→ policy_denied)', ['click', 'button', 'Delete account', '-s', 'cd'], { expectFail: true, expectMatch: /looks destructive \(Delete\)/ });
  run('click Save (통과)', ['click', 'button', 'Save', '-s', 'cd'], { expectMatch: /Clicked/ });
  run('click --confirm', ['click', 'button', 'Delete account', '--confirm', '--no-delta', '-s', 'cd'], { expectMatch: /Clicked/ });
  check('--confirm 이 실제로 눌렀다', q("document.querySelector('button').textContent", 'cd') === 'GONE');
  run('restart (정책 물려받음)', ['restart', 'cd', 'file://' + path.join(OUT, 'destr.html'), ...LAUNCH]);
  run('click 파괴적 이름 (restart 뒤에도 거부)', ['click', 'button', 'Delete account', '-s', 'cd'], { expectFail: true, expectMatch: /looks destructive/ });
  run('kill cd', ['kill', 'cd', '--clean']);
  run('new --allow example.com', ['new', 'al', 'https://example.com', '--ephemeral', '--allow', 'example.com', ...LAUNCH]);
  const dxo = run('drift (확장 축 ok)', ['drift', 'al']);
  check('drift 가 확장 축을 낸다', /extensions\s+✓/.test(dxo.out), dxo.out.slice(0, 120));
  // 확장을 손으로 내리면 규칙은 대장에 있는데 브라우저엔 없다 — drift 가 그것을 잡는다 (#192)
  const targets = run('cdp Target.getTargets', ['cdp', '--browser', 'Target.getTargets', '-s', 'al']);
  const extId = (/chrome-extension:\/\/([a-z]+)\//.exec(targets.out) ?? [])[1];
  if (extId) run('cdp Extensions.uninstall', ['cdp', '--browser', 'Extensions.uninstall', JSON.stringify({ id: extId }), '-s', 'al']);
  run('drift (확장 축 DRIFT → exit≠0)', ['drift', 'al'], { expectFail: true, expectMatch: /extensions\s+✗ DRIFT/ });
  run('nav 밖 (CLI 층 → policy_denied)', ['nav', 'https://www.iana.org/', '-s', 'al'], { expectFail: true, expectMatch: /outside --allow/ });
  check('fetch 밖 (브라우저 층, dNR)', /blocked/.test(q('fetch("https://www.iana.org/").then(r=>"ok "+r.status).catch(e=>"blocked: "+e.message)', 'al') ?? ''), '');
  check('fetch 안 (허용)', /ok 200/.test(q('fetch("https://example.com/").then(r=>"ok "+r.status).catch(e=>"blocked")', 'al') ?? ''), '');
  check('WebRTC 억제 플래그가 선언에 있다', /webrtc-ip-handling-policy/.test(run('export al', ['export', 'al']).out));
  run('kill al', ['kill', 'al', '--clean']);

  // intercept (#178) — 차단·모킹. **서버가 무엇을 못 받았는가**로 증명한다: 페이지 쪽만
  // 보면 "차단됐다" 와 "원본이 원래 그렇게 답했다" 를 못 가른다. 픽스처의 서비스워커가
  // 스스로 /from-sw 를 부르므로, 그것이 서버에 안 닿으면 데몬이 못 덮던 자리를 확장이 덮는 것이다.
  {
    const icDir = fs.mkdtempSync(path.join(OUT, 'intercept-'));
    const srv = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'intercept-server.mjs'), icDir], { stdio: 'ignore' });
    const portFile = path.join(icDir, 'port');
    for (let i = 0; i < 50 && !fs.existsSync(portFile); i++) execFileSync('sleep', ['0.1']);
    const port = Number(fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8') : NaN);
    check('intercept 픽스처 서버가 떴다', Number.isFinite(port) && port > 0, `port=${port}`);
    if (Number.isFinite(port)) {
      const origin = `http://127.0.0.1:${port}`;
      const logFile = path.join(icDir, 'requests.jsonl');
      const got = () => {
        try { return new Set(fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).path)); } catch { return new Set(); }
      };
      const IC = ['-s', 'ic'];
      run('new --extensions (intercept 세션)', ['new', 'ic', `${origin}/`, '--ephemeral', '--extensions', ...LAUNCH]);
      execFileSync('sleep', ['2']);
      const base = got();
      check('기준선: 서버가 페이지·광고·API·SW 요청을 다 받았다', ['/', '/ads/banner.png', '/api/user', '/from-sw', '/sw-ok'].every(p => base.has(p)), [...base].join(' '));
      run('intercept block /ads/', ['intercept', 'block', '/ads/', ...IC], { expectMatch: /ic1 block/ });
      run('intercept block /from-sw', ['intercept', 'block', '/from-sw', ...IC], { expectMatch: /ic2 block/ });
      run('intercept mock /api/user', ['intercept', 'mock', '/api/user', '--body', '{"from":"mock"}', ...IC], { expectMatch: /status 200/ });
      run('headers set --host (같은 호스트에 헤더 규칙 공존)', ['headers', 'set', 'X-Tirno', 'yes', '--host', '127.0.0.1', ...IC]);
      run('intercept ls', ['intercept', 'ls', ...IC], { expectMatch: /ic3\s+│\s+mock/ });
      // SW 를 다시 install 시켜야 워커가 /from-sw 를 다시 보낸다
      q('navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister())))', 'ic');
      fs.writeFileSync(logFile, '');
      run('nav (규칙 적용 뒤)', ['nav', `${origin}/?2`, ...IC]);
      execFileSync('sleep', ['3']);
      const after = got();
      check('block: /ads/ 가 서버에 안 닿았다', !after.has('/ads/banner.png'), [...after].join(' '));
      check('block: SW 가 스스로 보낸 /from-sw 도 서버에 안 닿았다 (데몬이 못 덮던 자리)', !after.has('/from-sw') && after.has('/sw-ok'), [...after].join(' '));
      check('mock: /api/user 가 서버에 안 닿았다', !after.has('/api/user'), [...after].join(' '));
      check('mock: 페이지가 가짜 본문을 받았다', q('document.getElementById("api").textContent', 'ic') === '{"from":"mock"}');
      check('block: 이미지 naturalWidth 0', q('document.getElementById("ad").naturalWidth', 'ic') === '0');
      check('헤더 규칙이 통과 요청에 여전히 붙는다 (#151 의 함정 없음)', /"xTirno":"yes"/.test(fs.readFileSync(logFile, 'utf8')));
      run('intercept rm ic3', ['intercept', 'rm', 'ic3', ...IC], { expectMatch: /Removed ic3/ });
      fs.writeFileSync(logFile, '');
      run('reload (mock 제거 뒤)', ['reload', ...IC]);
      check('mock 제거 뒤 /api/user 가 서버에 닿는다', got().has('/api/user'));
      run('intercept rm --all', ['intercept', 'rm', '--all', ...IC], { expectMatch: /Removed 2/ });
      run('kill ic', ['kill', 'ic', '--clean']);
    }
    srv.kill();
  }
  run('attach smoke (정책 세션들이 active 를 가져갔다)', ['attach', 'smoke']);
  // MCP 서버 (#215) — stdin 으로 JSON-RPC 를 넣고 stdout 을 읽는다. 툴은 schema 에서 온다.
  {
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tirno_expect', arguments: { clause: ['count', 'button', 'ge', '1'] } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tirno_click', arguments: { target: 'button', name: 'Nope' } } },
    ];
    let out = '';
    try {
      out = execFileSync('node', [TIRNO, 'mcp', '--session', 'smoke'], { env, input: msgs.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { out = String(e.stdout ?? ''); }
    const replies = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const by = Object.fromEntries(replies.map(r => [r.id, r]));
    check('mcp initialize 가 서버 정보를 낸다', by[1]?.result?.serverInfo?.name === 'tirno', out.slice(0, 120));
    check('mcp tools/list 가 schema 에서 툴을 낸다', (by[2]?.result?.tools?.length ?? 0) > 10 && by[2].result.tools.some(t => t.name === 'tirno_snapshot'), String(by[2]?.result?.tools?.length));
    check('mcp tools/call 이 명령을 치고 텍스트를 돌려준다', /expect count/.test(by[3]?.result?.content?.[0]?.text ?? '') && by[3].result.isError === false, JSON.stringify(by[3]).slice(0, 160));
    check('mcp 실패는 isError 와 code', by[4]?.result?.isError === true && by[4].result._meta?.code === 'target_not_found', JSON.stringify(by[4]).slice(0, 160));
  }
  // 플러그인 (#216) — lighthouse 는 번들에 없다. 스모크의 audit 은 레포의 node_modules 로 돈다.
  run('plugin ls', ['plugin', 'ls'], { expectMatch: /audit.*found \((repo|plugin|global)\)/ });
  // 저널과 JSON 봉투 (#217)
  const jl = run('journal', ['journal', ...S]);
  check('저널이 성공·실패를 순서대로 낸다', /✓ click button click me/.test(jl.out) && /✗ click button Nope.*code:target_not_found/.test(jl.out), jl.out.slice(0, 300));
  run('journal --failed', ['journal', '--failed', ...S], { expectMatch: /✗/ });
  run('journal --as-recipe', ['journal', '--as-recipe', 'from-journal', '--last', '30', ...S], { expectMatch: /saved recipe "from-journal"/ });
  run('recipe rm from-journal', ['recipe', 'rm', 'from-journal']);
  {
    let out = '';
    try { out = execFileSync('node', [TIRNO, 'click', 'button', 'click me', ...S], { env: { ...env, TIRNO_JSON: '1' }, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = String(e.stdout); }
    check('TIRNO_JSON=1 성공 봉투 {ok:true, cmd, output, delta}', (() => { try { const j = JSON.parse(out.trim()); return j.ok === true && j.cmd === 'click' && /Clicked/.test(j.output) && 'delta' in j; } catch { return false; } })(), out.slice(0, 160));
    try { out = execFileSync('node', [TIRNO, 'forms', '--json', ...S], { env: { ...env, TIRNO_JSON: '1' }, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = String(e.stdout); }
    check('--json 출력은 봉투의 data 로 들어간다', (() => { try { const j = JSON.parse(out.trim()); return j.ok === true && Array.isArray(j.data); } catch { return false; } })(), out.slice(0, 160));
  }
  run('journal --clear', ['journal', '--clear', ...S], { expectMatch: /cleared/ });
  // 접근성 감사 (#219) — 알려진 위반이 심긴 픽스처. 위반마다 @N 이 붙고, expect a11y 가 게이트다.
  const A11Y = 'file://' + path.join(import.meta.dirname, 'fixtures', 'a11y-page.html');
  run('nav (a11y 픽스처)', ['nav', A11Y, ...S]);
  const ax = run('a11y', ['a11y', ...S]);
  for (const rule of ['names', 'labels', 'alt', 'headings', 'contrast', 'lang', 'title', 'tabindex', 'aria-refs', 'duplicate-id']) {
    check(`a11y 가 ${rule} 을 잡는다`, new RegExp(`\\s${rule}\\s`).test(ax.out), ax.out.split('\n').find(l => l.includes(rule)) ?? '(없음)');
  }
  check('위반에 @N 이 붙는다', /\[serious\]\s+alt\s+@\d+ img/.test(ax.out), ax.out.split('\n').find(l => /alt/.test(l)) ?? '');
  const axRef = (/alt\s+(@\d+) img/.exec(ax.out) ?? [])[1];
  run('click @N (a11y 가 준 ref 로 바로 조작)', ['click', axRef ?? '@0', '--synthetic', ...S], { expectMatch: /Clicked/ });
  run('a11y --rules headings', ['a11y', '--rules', 'headings', ...S], { expectMatch: /2 violations/ });
  run('a11y --fail-on serious (→ exit≠0)', ['a11y', '--fail-on', 'serious', ...S], { expectFail: true, expectMatch: /at serious or worse/ });
  run('expect a11y clean (→ exit≠0)', ['expect', 'a11y', 'clean', ...S], { expectFail: true, expectMatch: /worst serious/ });
  run('expect a11y serious le 20', ['expect', 'a11y', 'serious', 'le', '20', ...S]);
  const tab = run('a11y --tab-order', ['a11y', '--tab-order', ...S]);
  check('Tab 걷기가 tabindex=3 을 첫 정거장으로 낸다', /^\s+1 link "Jump"/m.test(tab.out), tab.out.split('\n')[1]);
  check('이름 없는 정거장 · 포커스 링 없음 · 화면 밖을 잡는다', /no accessible name/.test(tab.out) && /no visible focus ring/.test(tab.out) && /off-screen/.test(tab.out), tab.out.slice(0, 200));
  run('nav (example.com — a11y clean)', ['nav', 'https://example.com', ...S]);
  run('expect a11y clean (example.com)', ['expect', 'a11y', 'clean', ...S], { expectMatch: /clean/ });
  run('nav (픽스처 복귀)', ['nav', PAGE, ...S]);
  // role + 이름 문법과 expect / ensure (#210). 모호하면 거절, 없으면 거절 — 첫 것을 조용히 고르지 않는다.
  run('click button "click me" (role+name)', ['click', 'button', 'click me', ...S], { expectMatch: /Clicked button "click me"/ });
  check('role+name 클릭이 실제로 눌렸다', q("document.getElementById('status').textContent") === 'clicked');
  run('click button (모호 → exit≠0)', ['click', 'button', ...S], { expectFail: true, expectMatch: /matches \d+:/ });
  run('click button "Nope" (없음 → exit≠0)', ['click', 'button', 'Nope', ...S], { expectFail: true, expectMatch: /No button named "Nope"/ });
  run('fill textbox "type here" (role+name)', ['fill', 'textbox', 'type here', 'by-role', ...S], { expectMatch: /Filled textbox "type here"/ });
  check('role+name fill 값', q("document.getElementById('text').value") === 'by-role');
  run('hover link "anchor" (role+name)', ['hover', 'link', 'anchor', ...S], { expectMatch: /Hovered link "anchor"/ });
  run('wait-for link "anchor" (role+name)', ['wait-for', 'link', 'anchor', '--timeout', '3000', ...S], { expectMatch: /Visible: link "anchor"/ });
  run('expect url matches', ['expect', 'url', 'matches', 'smoke-page', ...S], { expectMatch: /expect url/ });
  run('expect url = (틀림 → exit≠0)', ['expect', 'url', '=', 'https://nope/', ...S], { expectFail: true, expectMatch: /page says/ });
  run('expect text', ['expect', 'text', 'tirno smoke page', ...S]);
  run('expect count button ge 2', ['expect', 'count', 'button', 'ge', '2', ...S]);
  run('expect text 없음 within 300ms (→ exit≠0)', ['expect', 'text', 'never-there', 'within', '300ms', ...S], { expectFail: true, expectMatch: /after 300ms/ });
  run('ensure textbox = (채움)', ['ensure', 'textbox', 'type here', '=', 'ensured-value', ...S], { expectMatch: /ensured — "ensured-value"/ });
  run('ensure textbox = (already)', ['ensure', 'textbox', 'type here', '=', 'ensured-value', ...S], { expectMatch: /already/ });
  run('ensure checkbox checked', ['ensure', 'checkbox', 'checked', ...S], { expectMatch: /ensured — checked/ });
  check('체크박스가 실제로 켜졌다', q("document.getElementById('check').checked") === 'true');
  run('ensure checkbox checked (already)', ['ensure', 'checkbox', 'checked', ...S], { expectMatch: /already/ });
  run('ensure checkbox unchecked', ['ensure', 'checkbox', 'unchecked', ...S], { expectMatch: /ensured — unchecked/ });
  run('ensure combobox = B (라벨로)', ['ensure', 'combobox', '=', 'B', ...S], { expectMatch: /ensured — "B" \(value "b"\)/ });
  run('expect value combobox = b', ['expect', 'value', 'combobox', '=', 'b', ...S]);
  run('ensure visible text (already)', ['ensure', 'visible', 'text', 'tirno smoke page', ...S], { expectMatch: /already/ });
  run('ensure visible text 없음 within 300ms (→ exit≠0)', ['ensure', 'visible', 'text', 'never-there', 'within', '300ms', ...S], { expectFail: true, expectMatch: /still hidden/ });
  const sn = run('snapshot (checked 상태)', ['snapshot', ...S]);
  check('스냅샷이 체크 상태를 [checked] 로 낸다', !/checkbox \[checked\]/.test(sn.out), '해제한 뒤라 없어야 한다');
  q("document.getElementById('text').value=''; document.getElementById('status').textContent='idle'");
  // 행동 뒤 delta (#209) — 눌렀으면 무엇이 변했는지, 안 변했으면 그렇다고.
  q("document.getElementById('status').textContent='idle'");
  const dl = run('click (delta: idle→clicked)', ['click', '#btn', ...S]);
  check('delta 가 빠진 줄과 생긴 줄을 낸다', /\+1  StaticText "clicked"/.test(dl.out) && /-1  StaticText "idle"/.test(dl.out), dl.out.slice(0, 160));
  const dl2 = run('click (delta: no change)', ['click', '#btn', ...S]);
  check('변한 게 없으면 no change', /no change/.test(dl2.out), dl2.out.slice(0, 120));
  const dl3 = run('click --no-delta', ['click', '#btn', '--no-delta', ...S]);
  check('--no-delta 면 성공 줄뿐', dl3.out.trim().split('\n').length === 1, dl3.out);
  q("document.getElementById('text').focus()");
  const dl4 = run('press Tab (delta: focus)', ['press', 'Tab', ...S]);
  check('포커스 이동이 delta 에 나온다', /focus: textbox "text" → textbox "area"/.test(dl4.out), dl4.out.slice(0, 120));
  q("document.getElementById('status').textContent='idle'");
  // 가려진 요소는 사람이 못 누른다. 합성 click() 은 뚫고 들어가 "Clicked" 를 찍었다 (#183).
  q("document.getElementById('cover').classList.add('on')");
  const cov = run('click 가려진 셀렉터 (→ exit≠0)', ['click', '#under', ...S], { expectFail: true });
  check('거절이 가린 요소를 이름으로 말한다', /covered at .* by div#cover\.modal-backdrop/.test(cov.out + cov.err),
    (cov.out + cov.err).slice(0, 120));
  check('가려진 버튼의 핸들러가 돌지 않았다', q("document.getElementById('status').textContent") !== 'under-clicked');
  const snapCov = run('snapshot (가려진 @ref 용)', ['snapshot', ...S]);
  const underRef = (/@(\d+)[^\n]*button "under"/.exec(snapCov.out) ?? [])[1];
  run('click 가려진 @ref (→ exit≠0)', ['click', `@${underRef ?? 0}`, ...S], { expectFail: true, expectMatch: /covered/ });
  run('click --synthetic (알고도 뚫는다)', ['click', `@${underRef ?? 0}`, '--synthetic', ...S], { expectMatch: /Clicked .*synthetic/ });
  check('--synthetic 은 핸들러를 돌린다', q("document.getElementById('status').textContent") === 'under-clicked');
  q("document.getElementById('cover').classList.remove('on'); document.getElementById('status').textContent='idle'");
  run('click 걷힌 뒤 (실제 마우스)', ['click', '#under', ...S], { expectMatch: /Clicked/ });
  check('실제 마우스 클릭이 핸들러를 돌렸다', q("document.getElementById('status').textContent") === 'under-clicked');
  // 값에 공백·괄호·따옴표·유니코드가 들어간다 — fill 이 셸이나 이스케이프를 거치면 깨진다.
  const FILL = '안녕 world ("quoted") + 50%';
  run('fill', ['fill', '#text', FILL, ...S]);
  check('fill 값이 그대로 들어갔다', q("document.getElementById('text').value") === FILL,
    `실측: ${q("document.getElementById('text').value")}`);
  // 빈 값은 "Filled" 라고 말하고선 옛 값을 남겼다 — 지우는 것도 채우기다.
  run('fill (빈 값)', ['fill', '#text', '', ...S]);
  check('fill "" 가 실제로 지웠다', q("document.getElementById('text').value") === '',
    `실측: ${q("document.getElementById('text').value")}`);
  // "Filled" 는 요소가 그 값을 들고 있을 때만이다 — readonly 는 키를 버리고 maxlength 는
  // 뒤를 자르는데, 둘 다 keyboard.type 을 예외 없이 끝낸다 (#184).
  const ro = run('fill readonly (→ exit≠0)', ['fill', '#ro', 'x', ...S], { expectFail: true });
  check('readonly 거절이 이유를 말한다', /readonly/.test(ro.out + ro.err), (ro.out + ro.err).slice(0, 100));
  check('readonly 값이 그대로다', q("document.getElementById('ro').value") === 'locked');
  const cutFill = run('fill maxlength (→ exit≠0)', ['fill', '#short', 'hello', ...S], { expectFail: true });
  check('maxlength 불일치가 expected/actual 을 말한다', /expected "hello" but element reads "hel"/.test(cutFill.out + cutFill.err),
    (cutFill.out + cutFill.err).slice(0, 120));
  run('fill maxlength --no-verify (알고도 진행)', ['fill', '#short', 'hello', '--no-verify', ...S], { expectMatch: /Filled/ });
  run('fill --batch', ['fill', '--batch', '[{"target":"#text","value":"a"},{"target":"#area","value":"b"}]', ...S]);
  check('fill --batch 가 두 필드 모두 채웠다',
    q("document.getElementById('text').value") === 'a' && q("document.getElementById('area').value") === 'b');
  // type 은 포커스된 요소에 키 입력으로 들어가야 한다 — 붙는 위치까지가 계약이다.
  q("document.getElementById('text').focus()");
  run('type', ['type', 'typed (x)', ...S]);
  check('type 이 포커스된 입력에 붙었다', q("document.getElementById('text').value") === 'atyped (x)',
    `실측: ${q("document.getElementById('text').value")}`);
  run('press', ['press', 'Tab', ...S]);
  check('press Tab 이 포커스를 옮겼다', q('document.activeElement.id') === 'area',
    `실측: ${q('document.activeElement.id')}`);
  run('drag', ['drag', '#box', '#head', ...S]);
  run('scroll', ['scroll', 'down', ...S]);
  check('scroll 이 실제로 내려갔다', q('scrollY > 0') === 'true', `scrollY=${q('scrollY')}`);
  run('wait', ['wait', '100']);
  run('wait-for (selector)', ['wait-for', '#bottom', '--timeout', '5000', ...S]);
  run('wait-for --text', ['wait-for', '--text', 'bottom marker', '--timeout', '5000', ...S]);
  run('wait-for --network-idle', ['wait-for', '--network-idle', '--timeout', '5000', ...S]);
  // 타임아웃은 무한 대기가 아니라 exit 1 + 무엇을 기다렸는지로 끝나야 한다.
  // 셋은 대안이지 우선순위가 아니다 — 함께 주면 셀렉터가 조용히 무시됐다.
  run('wait-for (selector + --network-idle → exit≠0)',
    ['wait-for', '#bottom', '--network-idle', '--timeout', '5000', ...S],
    { expectFail: true, expectMatch: /one of/ });
  run('wait-for (타임아웃 → exit≠0)', ['wait-for', '#nope', '--timeout', '800', ...S],
    { expectFail: true, expectMatch: /#nope/ });
  fs.writeFileSync(`${OUT}/upload.txt`, 'x');
  run('upload', ['upload', '#file', `${OUT}/upload.txt`, ...S]);
  check('upload 된 파일이 input 에 붙었다',
    q("document.getElementById('file').files[0]?.name") === 'upload.txt');

  // ── 에뮬레이션 — "적용했다"는 출력이 아니라 페이지가 관측하는 값으로 판정한다.
  run('emulate --viewport', ['emulate', '--viewport', '1280x720', ...S]);
  check('emulate --viewport 실측', q("innerWidth + 'x' + innerHeight") === '1280x720',
    `실측: ${q("innerWidth + 'x' + innerHeight")}`);
  run('emulate --network', ['emulate', '--network', 'slow-3g', ...S]);
  run('emulate --cpu', ['emulate', '--cpu', '2', ...S]);
  run('emulate --dpr', ['emulate', '--dpr', '2', ...S]);
  check('emulate --dpr 실측', q('devicePixelRatio') === '2', `실측: ${q('devicePixelRatio')}`);
  // UA 문자열은 공백·괄호를 품는 대표 인자다.
  run('emulate --user-agent', ['emulate', '--user-agent', 'tirno-smoke UA (test)', ...S]);
  check('emulate --user-agent 실측', q('navigator.userAgent') === 'tirno-smoke UA (test)',
    `실측: ${q('navigator.userAgent')}`);
  run('emulate --color-scheme', ['emulate', '--color-scheme', 'dark', ...S]);
  check('emulate --color-scheme 실측', q("matchMedia('(prefers-color-scheme: dark)').matches") === 'true');
  run('emulate --geolocation', ['emulate', '--geolocation', '37.5,127.0', ...S]);
  // accuracy 만 주면 조용히 무시되고 "No emulation options" 로 끝났다 — 그 문구에도 안 나온다.
  run('emulate --geolocation-accuracy 단독 → exit≠0',
    ['emulate', '--geolocation-accuracy', '10', ...S],
    // 옛 문구("No emulation options … --geolocation …")에도 이 낱말이 있어서,
    // 무엇을 짝지어야 하는지 말하는 문장으로 못 박는다.
    { expectFail: true, expectMatch: /only applies with --geolocation/ });
  run('emulate --device', ['emulate', '--device', 'iPhone 14', ...S]);
  // device 프리셋이 실제로 적용하는 것은 화면 치수와 dpr 이다 (UA 는 적용 코드가 없다 —
  // emulate.ts 의 "keeps device UA" 주석은 코드와 다르다. 실측 근거로 여기서는 안 본다).
  check('emulate --device 실측 (screen 390 · dpr 3)',
    q('screen.width') === '390' && q('devicePixelRatio') === '3',
    `실측: screen.width=${q('screen.width')} dpr=${q('devicePixelRatio')}`);
  run('emulate --list-devices', ['emulate', '--list-devices'], { expectMatch: /iPhone/ });
  run('emulate --reset', ['emulate', '--reset', ...S]);
  // reset 은 흔적 없이 원상 복구여야 다음 검사가 이 위에 설 수 있다.
  check('emulate --reset 이 원상 복구했다',
    q("innerWidth + 'x' + innerHeight") === '1920x1080' && q('devicePixelRatio') === '1'
      && !(q('navigator.userAgent') ?? '').includes('tirno-smoke UA'),
    `실측: ${q("innerWidth + 'x' + innerHeight")} dpr=${q('devicePixelRatio')}`);

  // ── 성능/메모리 (산출물을 자기 분석 명령으로 되읽는 것까지가 왕복이다)
  run('trace', ['trace', '--duration', '2', '--out', `${OUT}/t.json`, ...S], { timeout: 120_000 });
  run('trace insight', ['trace', 'insight', `${OUT}/t.json`]);
  run('trace start', ['trace', 'start', `${OUT}/t2.json`, ...S], { timeout: 120_000 });
  run('trace stop', ['trace', 'stop', `${OUT}/t2.json`], { timeout: 120_000 });
  run('memory', ['memory', '--out', `${OUT}/h.heapsnapshot`, ...S], { timeout: 120_000 });
  run('memory load', ['memory', 'load', `${OUT}/h.heapsnapshot`], { timeout: 120_000 });
  run('memory details', ['memory', 'details', `${OUT}/h.heapsnapshot`, '--page-size', '5'], { timeout: 120_000 });

  // ── stall — 렌더러 밖 관측이라 JSON 계약(samples + summary.verdict)이 호출자의 전부다.
  const stall = run('stall --json', ['stall', '--window', '2', '--json', ...S], { timeout: 60_000 });
  let stallJson = null;
  try { stallJson = JSON.parse(stall.out); } catch { /* ignore */ }
  check('stall JSON 계약 (samples + summary.verdict)',
    (stallJson?.samples?.length ?? 0) > 0 && typeof stallJson?.summary?.verdict === 'string',
    stall.out.slice(0, 80));

  // ── schema — 기계가 읽는 계약. 이게 깨지면 스크립트 호출자 전부가 깨진다.
  const schema = run('schema', ['schema']);
  let schemaJson = null;
  try { schemaJson = JSON.parse(schema.out); } catch { /* ignore */ }
  check('schema 가 유효한 JSON 계약이다',
    schemaJson?.name === 'tirno' && (schemaJson?.commands?.length ?? 0) >= 60
      && schemaJson.commands.every(c => c.effects),
    schema.out.slice(0, 80));
  run('schema --pretty', ['schema', '--pretty']);
  // 별칭은 사람이 실제로 치는 이름이다 — 기계가 읽는 표면에도 있어야 한다.
  check('schema 가 별칭을 싣는다',
    schemaJson?.commands?.some(c => c.name === 'permissions ls' && (c.aliases ?? []).includes('perm ls')),
    JSON.stringify(schemaJson?.commands?.find(c => c.name === 'permissions ls')?.aliases ?? null));

  // ── chrome — 어느 바이너리를 쓰는지, 그리고 그 답을 적어둘 수 있는지.
  const chromeShow = run('chrome', ['chrome']);
  check('chrome 이 고른 바이너리와 후보 표를 낸다',
    /SOURCE/.test(chromeShow.out) && /\$TIRNO_CHROME/.test(chromeShow.out),
    chromeShow.out.split('\n')[0] ?? '');
  if (CHROME_BIN) run('chrome set', ['chrome', 'set', CHROME_BIN], { expectMatch: /chrome = / });
  const cfgPath = path.join(ROOT, 'config.json');
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
  // 적어둔 다음에는 --executable-path 없이도 그 바이너리로 뜬다 — 그게 이 명령의 존재 이유다.
  if (CHROME_BIN) check('chrome set 이 설정에 남는다', cfg?.chromePath === CHROME_BIN, `실측: ${cfg?.chromePath ?? '(없음)'}`);
  if (CHROME_BIN) {
    const chromeAfterSet = run('chrome (설정 반영)', ['chrome']);
    check('설정한 경로가 판정 결과가 된다', chromeAfterSet.out.includes(CHROME_BIN),
      chromeAfterSet.out.split('\n')[0] ?? '');
  }
  run('chrome set (실행파일 아님 → exit≠0)', ['chrome', 'set', `${OUT}/not-a-binary`], { expectFail: true });
  run('chrome rm', ['chrome', 'rm']);
  run('chrome rm (두 번째는 조용히)', ['chrome', 'rm'], { expectMatch: /Nothing was configured/ });

  // setup — 진단은 항상 돌 수 있어야 한다. 실제 다운로드(~200MB)는 스모크가 안 한다:
  // 네트워크와 시간을 그만큼 쓰는 것은 게이트가 할 일이 아니다. 대신 확인 없이는
  // 받지 않는다는 것과, --json 계약이 유지되는지를 본다.
  const setupCheck = run('setup --check', ['setup', '--check', '--json']);
  let setupJson = null;
  try { setupJson = JSON.parse(setupCheck.out); } catch { /* ignore */ }
  check('setup --check 가 플랫폼과 후보를 기계가 읽게 낸다',
    typeof setupJson?.platform === 'string' && Array.isArray(setupJson?.candidates)
      && typeof setupJson?.supported === 'boolean',
    setupCheck.out.slice(0, 90));
  // stdin 이 TTY 가 아니면 물어볼 사람이 없다 — 그때 200MB 를 그냥 받으면 안 된다.
  run('setup (비대화형 + --yes 없음 → exit≠0)', ['setup', '--force'], { expectFail: true });

  // ── cdp
  run('cdp', ['cdp', 'Runtime.evaluate', '{"expression":"1+1","returnByValue":true}', ...S]);
  run('cdp --browser', ['cdp', '--browser', 'Browser.getVersion', ...S]);

  // ── cache — 쓴 것을 다시 읽어 같은지 본다. 도메인 있는 URL 로 한 번 더 쓴다.
  run('nav (cache 용 https)', ['nav', 'https://example.com', ...S]);
  run('snapshot (cache 쓰기)', ['snapshot', ...S]);
  run('nav (픽스처 복귀)', ['nav', PAGE, ...S]);
  run('cache list', ['cache', 'list'], { expectMatch: /example\.com/ });
  const cacheLoad = run('cache load', ['cache', 'load', PAGE, '--json']);
  let cacheEntry = null;
  try { cacheEntry = JSON.parse(cacheLoad.out); } catch { /* ignore */ }
  check('cache load 왕복 (snapshot 이 쓴 것을 그대로 읽는다)', cacheEntry?.url === PAGE,
    cacheLoad.out.slice(0, 80));
  // load 가 찾는 항목은 list 에도 나와야 한다 — 적어놓고 못 꺼내는 캐시는 캐시가 아니다.
  const cl = run('cache list (file:// 항목)', ['cache', 'list']);
  // PATH 열은 50자에서 잘려 파일명으로 못 찾고, 뷰포트로 찾으면 example.com 행이 대신
  // 통과한다. file:// 항목의 표지는 DOMAIN 이 비어 있다는 것 하나뿐이다.
  check('cache list 가 file:// 항목도 보여준다',
    cl.out.split('\n').some(l => /^\s+│/.test(l)),
    `DOMAIN 이 빈 행이 없음 (load 는 찾는데): ${cl.out.trim().split('\n').length}줄`);
  // 무인자 prune 은 나이 검사 없이 전량을 지웠다 — 설명은 "old" 였다. 이제 거부한다.
  // 낡음 판정 (#188) — 세션이 그 페이지에 있으면 fresh, 위에 무언가 덮이면 STALE, 다른 URL 이면 비교 안 함
  const fresh = run('cache load (지금 화면과 비교 → fresh)', ['cache', 'load', PAGE, ...S]);
  check('fresh 와 거리가 머리글에 있다', /distance: \d+\/256 \(fresh/.test(fresh.out), fresh.out.split('\n')[2]);
  q("document.body.insertAdjacentHTML('beforeend','<div id=smoke-modal style=\"position:fixed;inset:15% 25%;background:#222\"></div>')");
  run('cache load (모달 덮임 → STALE, exit≠0)', ['cache', 'load', PAGE, ...S], { expectFail: true, expectMatch: /STALE/ });
  run('cache load --allow-stale', ['cache', 'load', PAGE, '--allow-stale', ...S], { expectMatch: /STALE/ });
  q("document.getElementById('smoke-modal').remove()");
  // 되찾기 (#187) — 문서를 다시 띄운 뒤에도 캐시의 @N 으로 바로 눌린다. 그 전엔 Unknown ref 였다.
  run('reload (backendId 무효화)', ['reload', ...S]);
  const rs = run('cache load (되찾아 ref store 채움)', ['cache', 'load', PAGE, ...S]);
  check('못 찾은 것(닫힌 select 의 팝업)은 UNRESOLVED 로 이름을 댄다', /MenuListPopup.*UNRESOLVED/.test(rs.out), rs.out.split('\n').find(l => /UNRESOLVED/.test(l)) ?? '(없음)');
  run('cache load --require-all (→ exit≠0)', ['cache', 'load', PAGE, '--require-all', ...S], { expectFail: true, expectMatch: /could not be found/ });
  const btnLine = rs.out.split('\n').find(l => /button "click me"/.test(l)) ?? '';
  check('버튼 ref 가 되찾아졌다', /← resolved/.test(btnLine), btnLine.slice(0, 100));
  check('요약 줄이 채널별 개수를 센다', /loaded \d+ refs, \d+ resolved \(/.test(rs.out), rs.out.split('\n').at(-2));
  const cachedBtn = (/^@(\d+)\s.*button "click me"/m.exec(rs.out) ?? [])[1];
  q("document.getElementById('status').textContent='idle'");
  run('click @N (캐시에서 되찾은 ref)', ['click', `@${cachedBtn ?? 0}`, ...S], { expectMatch: /Clicked/ });
  check('되찾은 ref 로 누른 것이 실제로 눌렸다', q("document.getElementById('status').textContent") === 'clicked');
  const nc = run('cache load --no-compare', ['cache', 'load', PAGE, '--no-compare', ...S]);
  check('비교 안 했으면 그렇다고 적는다', /not compared — --no-compare/.test(nc.out), nc.out.split('\n')[2]);
  run('cache prune (무인자 → exit≠0)', ['cache', 'prune'],
    { expectFail: true, expectMatch: /--older-than|--all/ });
  run('cache prune --older-than', ['cache', 'prune', '--older-than', '0']);
  // 모르는 mode 는 조용히 urlPath 로 처리돼, 오타가 매칭을 넓혔다.
  run('cache load --mode 오타 → exit≠0', ['cache', 'load', PAGE, '--mode', 'exakt'],
    { expectFail: true, expectMatch: /exact\|urlPath/ });
  // prune 0일 = 전부 삭제 — 지워졌다는 말이 아니라 다시 못 읽는 것으로 판정한다.
  run('cache load (prune 후 miss)', ['cache', 'load', PAGE], { expectFail: true });

  // ── record / replay — 기록→재생이 페이지 상태를 실제로 재현해야 한다.
  run('record start', ['record', 'start', ...S]);
  q("document.getElementById('status').textContent = 'idle'");
  run('click (기록 중)', ['click', '#btn', ...S]);
  run('record stop', ['record', 'stop', '--save', 'smokerec', ...S],
    { expectMatch: /[1-9]\d* events captured/ });
  run('record list', ['record', 'list'], { expectMatch: /smokerec/ });
  q("document.getElementById('status').textContent = 'idle'");
  run('replay', ['replay', 'smokerec', ...S], { timeout: 120_000 });
  check('replay 가 기록된 클릭을 재현했다', q("document.getElementById('status').textContent") === 'clicked');
  run('record rm', ['record', 'rm', 'smokerec']);
  const recAfterRm = run('record list (rm 후)', ['record', 'list']);
  check('record rm 이 실제로 지웠다', !recAfterRm.out.includes('smokerec'));
  run('replay (없는 기록 → exit≠0)', ['replay', 'nosuchrec', ...S],
    { expectFail: true, expectMatch: /No recording/ });

  // ── trail — 문서에 적힌 형태 그대로: capture <name> 은 인자 이중 등록으로 죽은 전과가 있다.
  run('trail capture <name>', ['trail', 'capture', 'smoketrail', '--goal', 'click the button', ...S],
    { expectMatch: /recording/ });
  q("document.getElementById('status').textContent = 'idle'");
  run('click (trail 기록 중)', ['click', '#btn', ...S]);
  run('trail save', ['trail', 'save', ...S], { expectMatch: /[1-9]\d* events/ });
  run('trail list', ['trail', 'list'], { expectMatch: /smoketrail/ });
  // show 는 채널 정보(dom/a11y/bbox)까지 나와야 replay 의 fallback 이 설 자리가 있다.
  run('trail show', ['trail', 'show', 'smoketrail'], { expectMatch: /dom:#btn/ });
  q("document.getElementById('status').textContent = 'idle'");
  run('trail replay', ['trail', 'replay', 'smoketrail', ...S],
    { timeout: 120_000, expectMatch: /1\/1 steps/ });
  check('trail replay 가 클릭을 재현했다', q("document.getElementById('status').textContent") === 'clicked');
  run('trail rm', ['trail', 'rm', 'smoketrail']);
  const trailAfterRm = run('trail list (rm 후)', ['trail', 'list']);
  check('trail rm 이 실제로 지웠다', !trailAfterRm.out.includes('smoketrail'));
  run('trail show (없는 trail → exit≠0)', ['trail', 'show', 'nosuchtrail'],
    { expectFail: true, expectMatch: /No trail/ });

  // ── 앵커 / gc / 통계
  run('anchor set', ['anchor', 'set', 'smokeanchor', 'smoke']);
  run('anchor ls', ['anchor', 'ls']);
  const anchorLs = run('anchor ls --json', ['anchor', 'ls', '--json']);
  check('anchor set→ls 왕복', anchorLs.out.includes('smokeanchor') && anchorLs.out.includes('smoke'),
    anchorLs.out.slice(0, 80));
  run('anchor rm', ['anchor', 'rm', 'smokeanchor']);
  const anchorAfterRm = run('anchor ls (rm 후)', ['anchor', 'ls', '--json']);
  check('anchor rm 이 실제로 지웠다', !anchorAfterRm.out.includes('smokeanchor'));
  run('gc --dry-run', ['gc', '--dry-run']);
  // gc 는 살아있는 세션을 절대 건드리면 안 된다 — 진짜 gc 를 돌리고 생존을 확인한다.
  run('gc (실제 실행)', ['gc']);
  check('gc 후에도 세션이 살아 있다', q('1 + 1') === '2');
  run('stats', ['stats']);
  // 없는 세션은 조용한 성공도, 스택트레이스도 아닌 "not found" 한 줄이어야 한다.
  run('eval (없는 세션 → exit≠0)', ['eval', '1+1', '-s', 'nosuch'],
    { expectFail: true, expectMatch: /not found/ });
  run('kill (없는 세션 → exit≠0)', ['kill', 'nosuch'],
    { expectFail: true, expectMatch: /not found/ });
  // 페이지 안에서 던진 예외도 실패다. exit 0 이면 스크립트는 $? 로 알 방법이 없다.
  run('eval (페이지 예외 → exit≠0)', ['eval', 'window.__nope.boom()', ...S],
    { expectFail: true, expectMatch: /boom|undefined/ });
  // 반대쪽 — 페이지가 { __error } 모양을 값으로 돌려주는 것은 실패가 아니다.
  run('eval (__error 모양의 값 → exit 0)', ['eval', '({__error: "값이다"})', ...S],
    { expectMatch: /값이다/ });
  // 결과를 { threw, value } 로 감싸면서 async 가 죽은 적이 있다 — puppeteer 는 최상위
  // promise 만 기다리므로 객체 안에 든 것은 {} 로 직렬화된다.
  run('eval (promise 를 기다린다)', ['eval', 'Promise.resolve(6*7)', ...S],
    { expectMatch: /^42$/m });
  run('eval (reject → exit≠0)', ['eval', 'Promise.reject(new Error("나가떨어짐"))', ...S],
    { expectFail: true, expectMatch: /나가떨어짐/ });

  // ── 멀티세션
  run('new (2번째 세션)', ['new', 'smoke2', '--ephemeral', PAGE, ...LAUNCH]);
  run('diff', ['diff', 'smoke', 'smoke2', '--out', `${OUT}/diff.png`], { timeout: 120_000 });
  check('diff 가 PNG 를 실제로 썼다', pngSize(`${OUT}/diff.png`) !== null);
  // 이 인자는 공백·괄호·유니코드를 품는다 — broadcast 가 셸을 타면 반드시 깨진다.
  // (document.title 은 셸을 무사히 통과하는 유일한 종류의 인자라 몇 달을 헛통과했다.)
  const bc = run('broadcast', ['broadcast', 'eval', "['가','나'].join(' ') + ' (ok)'"],
    { timeout: 120_000, expectMatch: /가 나 \(ok\)/ });
  check('broadcast 가 두 세션 모두에 닿았다', bc.out.includes('[smoke]') && bc.out.includes('[smoke2]'),
    bc.out.slice(0, 80));
  // 자식 하나가 실패하면 broadcast 도 실패다 — 죽은 pid 를 장부에 얹어 확인한다.
  // 나머지 일곱이 성공했다고 exit 0 이면 이 명령은 게이트로 쓸 수 없다.
  fs.writeFileSync(path.join(ROOT, 'sessions', 'deadsess.json'), JSON.stringify({
    name: 'deadsess', port: 59999, pid: 999999, userDataDir: path.join(ROOT, 'nope'),
    wsEndpoint: 'ws://127.0.0.1:59999/devtools/browser/x', chromeFlags: [],
    createdAt: new Date().toISOString(), lastAccess: new Date().toISOString(), headless: true,
  }));
  run('broadcast (자식 하나 실패 → exit≠0)', ['broadcast', 'eval', '1+1'],
    { timeout: 120_000, expectFail: true, expectMatch: /1\/\d+ failed: deadsess/ });
  fs.rmSync(path.join(ROOT, 'sessions', 'deadsess.json'), { force: true });

  // 소유권 거부도 실패다 — 호출자가 지목한 브라우저가 아직 돌고 있다.
  // 이 세션의 pid 는 스모크 자신이다: 살아 있고, 그 포트는 아무도 안 듣는다 → foreign.
  // 그래서 이 검사는 종료코드와 함께 "남의 프로세스를 안 죽였다"까지 증명한다
  // — 죽였다면 스모크가 여기서 사라진다.
  fs.writeFileSync(path.join(ROOT, 'sessions', 'notours.json'), JSON.stringify({
    name: 'notours', port: 59998, pid: process.pid, userDataDir: path.join(ROOT, 'nope'),
    wsEndpoint: 'ws://127.0.0.1:59998/devtools/browser/x', chromeFlags: [],
    createdAt: new Date().toISOString(), lastAccess: new Date().toISOString(), headless: true,
  }));
  run('kill (소유권 거부 → exit≠0)', ['kill', 'notours'],
    { expectFail: true, expectMatch: /Refusing to kill 'notours'/ });
  fs.rmSync(path.join(ROOT, 'sessions', 'notours.json'), { force: true });

  run('kill smoke2', ['kill', 'smoke2', '--clean']);

  // ── screencast
  run('screencast start', ['screencast', 'start', '--out', `${OUT}/cast`, ...S]);
  run('reload (프레임 유발)', ['reload', ...S]);
  run('screencast stop', ['screencast', 'stop', '--out', `${OUT}/cast`], { timeout: 120_000 });
  // start/stop 이 0 으로 끝나도 프레임이 없으면 캡처는 안 된 것이다.
  check('screencast 가 index.json 과 프레임을 남겼다',
    fs.existsSync(`${OUT}/cast/index.json`)
      && fs.readdirSync(`${OUT}/cast`).some(f => f.endsWith('.png') || f.endsWith('.jpeg')),
    fs.existsSync(`${OUT}/cast`) ? `cast/: ${fs.readdirSync(`${OUT}/cast`).join(',').slice(0, 80)}` : 'cast 디렉터리 없음');

  // ── audit (lighthouse — 느림)
  run('audit (https)', ['audit', 'https://example.com', '--out', `${OUT}/lh.html`, '--json', `${OUT}/lh.json`, '--quiet', ...S], { timeout: 300_000 });
  let lhr = null;
  try { lhr = JSON.parse(fs.readFileSync(`${OUT}/lh.json`, 'utf8')); } catch { /* ignore */ }
  check('audit 산출물 왕복 (html + 파싱 가능한 LHR)',
    fs.existsSync(`${OUT}/lh.html`) && !!lhr?.categories, 'lh.html/lh.json 누락 또는 LHR 아님');

  // ── 세션 마무리 — rename → restart 는 이름과 프로세스가 함께 갈아타는지까지 본다.
  run('rename', ['rename', 'smoke', 'smoke-renamed']);
  let renamedLs = null;
  try { renamedLs = JSON.parse(run('ls (rename 후)', ['ls', '--json']).out); } catch { /* ignore */ }
  check('rename 왕복 (새 이름만 남는다)',
    renamedLs?.some(s => s.name === 'smoke-renamed') && !renamedLs?.some(s => s.name === 'smoke'));
  const pidBefore = renamedLs?.find(s => s.name === 'smoke-renamed')?.pid;
  run('restart', ['restart', 'smoke-renamed', PAGE, ...LAUNCH], { timeout: 120_000 });
  let restartLs = null;
  try { restartLs = JSON.parse(execFileSync('node', [TIRNO, 'ls', '--json'], { env, encoding: 'utf8' })); } catch { /* ignore */ }
  const pidAfter = restartLs?.find(s => s.name === 'smoke-renamed')?.pid;
  check('restart 가 새 프로세스로 되살렸다',
    typeof pidAfter === 'number' && pidAfter !== pidBefore && q('document.title', 'smoke-renamed') === 'tirno smoke',
    `pid ${pidBefore} → ${pidAfter}`);
  run('kill --clean', ['kill', 'smoke-renamed', '--clean']);

  // ── 레거시 고정 포트 + 메타 보존 — restart 가 launch 옵션을 물려받는지가 요점이다.
  if (CHROME_BIN) {
    run('new --port --executable-path --group', ['new', 'smokefixed', '--ephemeral', '--port', '9411',
      '--headless', '--executable-path', CHROME_BIN, '--group', 'smokegrp',
      ...(extraFlags.length ? ['--', ...extraFlags] : [])]);
    run('ls (고정 포트 세션)', ['ls']);
    run('eval (고정 포트 세션)', ['eval', '1+1', '-s', 'smokefixed']);
    run('restart (옵션 없이)', ['restart', 'smokefixed', '--headless', '--ephemeral',
      ...(extraFlags.length ? ['--', ...extraFlags] : [])], { timeout: 120_000 });
    let fixedMeta = null;
    try { fixedMeta = JSON.parse(execFileSync('node', [TIRNO, 'export', 'smokefixed'], { env, encoding: 'utf8' })); } catch { /* ignore */ }
    // --executable-path 는 메타에 저장돼 restart 가 물려받아야 한다 — 잃으면 다른 브라우저로 되살린다.
    check('restart 가 --executable-path 를 물려받았다', fixedMeta?.executablePath === CHROME_BIN,
      `실측: ${fixedMeta?.executablePath ?? '(없음)'}`);
    // group 은 kill --group / broadcast --group 의 대상 선정 근거다 — 잃으면 그 세션이
    // 자기가 속한 그룹 작업에서 조용히 빠진다.
    check('restart 가 --group 태그를 물려받았다', fixedMeta?.group === 'smokegrp',
      `실측: ${fixedMeta?.group ?? '(없음)'}`);
    run('kill (고정 포트 세션)', ['kill', 'smokefixed', '--clean']);
    // kill --clean 뒤 같은 이름은 즉시 다시 쓸 수 있어야 한다 — 장부 잔재가 남으면 여기서 걸린다.
    run('new (같은 이름 재사용)', ['new', 'smokefixed', '--ephemeral', ...LAUNCH]);
    run('kill (재사용 세션)', ['kill', 'smokefixed', '--clean']);
  } else {
    run('new --port (레거시)', ['new', 'smokefixed', '--ephemeral', '--port', '9411', ...LAUNCH]);
    run('eval (고정 포트 세션)', ['eval', '1+1', '-s', 'smokefixed']);
    run('kill (고정 포트 세션)', ['kill', 'smokefixed', '--clean']);
    results.push({ label: '메타 보존 검사', cmd: '-', exit: '-', ms: 0, ok: true, note: 'chrome 경로 미해결 — 건너뜀' });
  }

  // ── 격리 — 스모크는 실제 ~/.tirno 에 아무것도 남기면 안 된다.
  // 빈 디렉터리 생성도 누출로 센다 — 저장소 하나가 루트 밖으로 새면 그 흔적부터 나온다.
  const escaped = lsTree(HOME_TIRNO).filter(p => !homeBefore.has(p));
  check('격리 — 실제 ~/.tirno 에 새 파일이 없다', escaped.length === 0,
    `누출: ${escaped.join(', ').slice(0, 140)}`);
  // 실패해도 사용자 홈은 원래대로 돌려놓는다 — 이 스모크가 만든 것이 확실한 경로만.
  for (const rel of escaped) {
    if (/^refs\/(smoke|smoke2|smoke-renamed|smokefixed)\.json$/.test(rel) || rel === 'active-trail.json') {
      fs.rmSync(path.join(HOME_TIRNO, rel), { force: true });
    }
  }
  // 이번 실행이 새로 만든 디렉터리는 비어 있을 때만 걷는다 — rmdir 는 내용물이 있으면 거부한다.
  for (const rel of escaped.filter(p => p.endsWith('/')).sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(path.join(HOME_TIRNO, rel)); } catch { /* 비어 있지 않으면 그대로 둔다 */ }
  }
}

let crashed = null;
try {
  main();
} catch (e) {
  crashed = e;
} finally {
  // 실패 경로에서도 크롬은 반드시 정리한다 — 스모크가 죽어도 브라우저가 남으면 안 된다.
  try {
    execFileSync('node', [TIRNO, 'kill', '--all', '--clean'], {
      env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { /* 남은 세션이 없으면 그걸로 족하다 */ }
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
}

// `known` 은 결함을 통과로 바꾸는 면죄부다. 결함이 고쳐진 뒤에도 표시가 남으면 그
// 검사는 영영 아무것도 지키지 않는다 — 통과하는 순간 실패로 만들어 표시를 떼게 한다.
const staleKnown = results.filter(r => r.ok && r.known);
const bad = results.filter(r => !r.ok && !r.known);
const knownBad = results.filter(r => !r.ok && r.known);
console.log(`\n총 ${results.length}건 · 통과 ${results.length - bad.length - knownBad.length} · 실패 ${bad.length} · 알려진 결함 ${knownBad.length} · ${((Date.now() - wallT0) / 1000).toFixed(1)}s`);
for (const r of knownBad) console.log(`  KNWN  ${r.label} — ${r.known}  (${r.note})`);
for (const r of bad) console.log(`  FAIL  ${r.label}  [exit ${r.exit}]  ${r.note}`);
for (const r of staleKnown) console.log(`  STALE ${r.label} — 이제 통과한다. { known: '${r.known}' } 를 떼라.`);
if (crashed) {
  console.log(`\n하네스 자체가 죽었다: ${crashed.stack ?? crashed}`);
  process.exit(1);
}
process.exit(bad.length === 0 && staleKnown.length === 0 ? 0 : 1);
