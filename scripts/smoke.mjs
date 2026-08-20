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
function resolveChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    try {
      const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (p) return p;
    } catch { /* next */ }
  }
  return null;
}

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
    // new-tab 이 앞을 가져가 픽스처 탭은 hidden — select 가 실제로 앞에 세우는지는
    // visibilityState 로만 판정된다. (select 는 bringToFront 다 — 이후 명령의 대상
    // 선정을 바꾸지 않는다. eval 류는 여전히 "마지막 콘텐츠 페이지"로 간다.)
    check('select 전 픽스처 탭이 hidden (전제)', q('document.visibilityState') === 'hidden');
    run('select', ['select', fixtureId, ...S]);
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
  // a11y 트리에 픽스처의 버튼이 보여야 스냅샷이 "내용을 본" 것이다.
  check('snapshot 에 버튼이 보인다', snap.out.includes('click me'), snap.out.slice(0, 80));
  run('snapshot --verbose', ['snapshot', '--verbose', ...S]);
  run('console', ['console', ...S]);
  // --reload 는 페이지 로드 시점의 로그를 다시 잡는 게 존재 이유다.
  run('console --reload', ['console', '--reload', ...S], { expectMatch: /smoke page loaded/ });
  run('console --show 0', ['console', '--reload', '--show', '0', ...S]);
  run('network', ['network', ...S]);
  const net = run('network --json', ['network', '--json', ...S]);
  let netRows = null;
  try { netRows = JSON.parse(net.out); } catch { /* ignore */ }
  check('network --json 에 문서 요청이 status 200 으로 잡힌다',
    Array.isArray(netRows) && netRows.some(r => String(r.url).endsWith('smoke-page.html') && r.status === 200),
    net.out.slice(0, 80));

  // ── 입력
  run('eval', ['eval', 'document.title', ...S]);
  // 이 인자는 공백·따옴표·괄호·유니코드를 전부 품는다 — 셸을 태우면 반드시 깨진다.
  run('eval (공백·따옴표·괄호·유니코드 인자)',
    ['eval', "['가','b c'].join(' + ') + ' (ok)'", ...S],
    { expectMatch: /가 \+ b c \(ok\)/ });
  run('click (selector)', ['click', '#btn', ...S]);
  check('click 이 페이지 상태를 바꿨다', q("document.getElementById('status').textContent") === 'clicked');
  run('click (coords)', ['click', '100,100', ...S]);
  // 없는 셀렉터는 매달리지도, 조용히 넘어가지도 말아야 한다.
  run('click (없는 셀렉터 → exit≠0)', ['click', '#definitely-not-there', ...S],
    { expectFail: true, expectMatch: /No element/ });
  run('hover', ['hover', '#link', ...S]);
  check('hover 가 mouseover 를 실제로 쐈다', q("document.getElementById('status').textContent") === 'hovered');
  // 값에 공백·괄호·따옴표·유니코드가 들어간다 — fill 이 셸이나 이스케이프를 거치면 깨진다.
  const FILL = '안녕 world ("quoted") + 50%';
  run('fill', ['fill', '#text', FILL, ...S]);
  check('fill 값이 그대로 들어갔다', q("document.getElementById('text').value") === FILL,
    `실측: ${q("document.getElementById('text').value")}`);
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
  run('cache prune (무인자 → exit≠0)', ['cache', 'prune'],
    { expectFail: true, expectMatch: /--older-than|--all/ });
  run('cache prune --older-than', ['cache', 'prune', '--older-than', '0']);
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
  const CHROME_BIN = resolveChrome();
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
