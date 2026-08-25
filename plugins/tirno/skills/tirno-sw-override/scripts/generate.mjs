#!/usr/bin/env node
// tirno sw-proxy — 설정 하나로 부트스트랩 산출물을 굽는다.
//
//   node scripts/sw-proxy/generate.mjs <mounts.json> [--out <dir>]
//
// 하는 일은 하나다: origin 의 지정한 경로를 로컬 빌드가 내게 만든다.
//
// SW 는 scope 당 하나이고 scope 는 **문서**로 매칭되므로 앱마다 SW 를 둘 수 없다.
// 대신 SW 를 커널로 두고 배포 산출물을 **레이어**로 얹는다 — 순서대로 해석해 먼저
// 가진 레이어가 이기고, 아무도 안 가지면 원본으로 간다. 런타임에 mount/unmount 한다.
//
// 나오는 것 — __tirno-sw.js · __tirno-boot.html · serve.mjs · cert.pem/key.pem

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const cfgPath = args.find(a => !a.startsWith('--'));
if (!cfgPath) {
  console.error('사용법: node scripts/sw-proxy/generate.mjs <mounts.json> [--out <dir>]');
  process.exit(1);
}
const cfgDir = path.dirname(path.resolve(cfgPath));
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : cfgDir;
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

if (!cfg.origin) { console.error('설정에 "origin" 이 없다'); process.exit(1); }
if (!Array.isArray(cfg.mounts) || !cfg.mounts.length) {
  console.error('설정에 "mounts" 가 없거나 비어 있다');
  process.exit(1);
}
const host = new URL(cfg.origin).hostname;
const port = cfg.port ?? 8443;

// scope 는 **문서**로 매칭된다 — 자산이 어디 있느냐가 아니라, 볼 페이지가 어디 있느냐다.
// 문서가 이 scope 아래 있어야 제어되고, 그러면 그 문서의 모든 요청이 SW 로 온다
// (경로가 scope 밖이어도 온다). 그래서 앱마다 SW 를 두는 것은 불가능하다.
const scope = cfg.scope ?? '/';
if (!scope.startsWith('/') || !scope.endsWith('/')) {
  console.error(`scope 는 "/" 로 시작하고 "/" 로 끝나야 한다 — 지금 ${JSON.stringify(scope)}`);
  process.exit(1);
}

// ── 마운트를 편다.
//    { path: "/_/app/", root: "./app/dist" }  → 그 디렉터리 전부를 그 접두사 아래로
//    { path: "/vendor/x.js", file: "./x.js" } → 파일 하나
//
// origin 의 경로와 로컬 경로는 **다를 수 있다.** 앱의 dist 는 자기 루트가 `/` 지만
// origin 에서는 `/_/app/` 아래 사는 것이 보통이다 — 그 어긋남을 여기서 흡수한다.
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

const map = new Map();          // origin 경로 → 로컬 절대경로 (서버 기본값, 위 레이어가 이긴다)
const layerFile = new Map();    // "<layerId>\0<경로>" → 로컬 절대경로
const layers = [];
const errors = [];
const seenName = new Set();
for (const [i, m] of cfg.mounts.entries()) {
  const label = m.path ?? `mounts[${i}]`;
  if (!m.path) { errors.push(`${label}: "path" 가 없다`); continue; }
  // 이름은 status·x-tirno-layer·mount/unmount 의 키다. 안 주면 경로에서 만든다.
  const name = m.name ?? (m.path.replace(/^\/+|\/+$/g, '').split('/').pop() || 'root');
  if (seenName.has(name)) { errors.push(`${label}: 이름이 겹친다 — ${name}`); continue; }
  seenName.add(name);

  // navigateFallback 은 낼 문서가 하나로 정해질 때만 뜻이 있다.
  let navigateFallback;
  if (m.navigateFallback !== undefined) {
    if (m.path.endsWith('/')) {
      errors.push(`${label}: navigateFallback 은 파일 마운트에만 쓴다 — 디렉터리는 어느 문서를 낼지 정해지지 않는다`);
      continue;
    }
    if (typeof m.navigateFallback !== 'string' || !m.navigateFallback.startsWith('/')) {
      errors.push(`${label}: navigateFallback 은 "/" 로 시작하는 경로여야 한다 — 지금 ${JSON.stringify(m.navigateFallback)}`);
      continue;
    }
    navigateFallback = m.navigateFallback;
  }

  if (m.path.endsWith('/')) {
    if (!m.root) { errors.push(`${label}: 디렉터리 마운트에는 "root" 가 필요하다`); continue; }
    const root = path.resolve(cfgDir, m.root);
    if (!fs.existsSync(root)) { errors.push(`${label}: root 가 없다 — ${root}`); continue; }
    const own = [];
    for (const f of walk(root)) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      const urlPath = m.path + rel;
      own.push(urlPath);
      layerFile.set(`${i}-${name}\u0000${urlPath}`, f);
      // 겹침은 오류가 아니라 우선순위다 — 먼저 선언된 레이어가 이긴다.
      if (!map.has(urlPath)) map.set(urlPath, f);
    }
    layers.push({ id: `${i}-${name}`, name, mount: m.path, from: m.root,
                  enabled: m.enabled !== false, paths: own });
  } else {
    if (!m.file) { errors.push(`${label}: 파일 마운트에는 "file" 이 필요하다`); continue; }
    const file = path.resolve(cfgDir, m.file);
    if (!fs.existsSync(file)) { errors.push(`${label}: file 이 없다 — ${file}`); continue; }
    layerFile.set(`${i}-${name}\u0000${m.path}`, file);
    if (!map.has(m.path)) map.set(m.path, file);
    layers.push({ id: `${i}-${name}`, name, mount: m.path, from: m.file,
                  enabled: m.enabled !== false, paths: [m.path],
                  ...(navigateFallback ? { navigateFallback } : {}) });
  }
}
if (errors.length) { console.error(errors.map(e => '✗ ' + e).join('\n')); process.exit(1); }
if (!map.size) { console.error('마운트가 아무 파일도 가리키지 않는다'); process.exit(1); }

const paths = [...map.keys()].sort();

// ── 페이지 안의 확인 창.
//
// 워커가 control 경로로 직접 내고, 마운트된 HTML 에만 태그가 들어간다. 원본 응답은
// 건드리지 않는다 — 이 도구는 파일을 내는 것이지 응답을 고치는 것이 아니고, 배포 전
// 빌드를 "실제 사이트에서" 확인하는 판에 문서를 변형하면 확인 대상 자체가 오염된다.
//
// 그래서 문서를 마운트하지 않는 구성에서는 창이 뜨지 않는다. 그것이 맞는 동작이다 —
// 창이 있다는 것은 워커가 이 문서를 내주고 있다는 뜻이고, 안 내주면 할 말이 없다.
const overlayOn = cfg.overlay !== false;
const overlaySrc = overlayOn
  ? fs.readFileSync(new URL('./overlay.js', import.meta.url), 'utf-8')
  : '';

// ── buildId — 경로와 그 내용에서 나온다. 무엇이든 바뀌면 activate 가 옛 캐시를 지운다.
const h = crypto.createHash('sha1').update(scope).update(overlaySrc);
for (const l of layers) {
  h.update(l.id).update(l.navigateFallback ?? '');
  for (const p of l.paths) h.update(p).update(fs.readFileSync(layerFile.get(l.id + '\u0000' + p)));
}
const buildId = h.digest('hex').slice(0, 12);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '__tirno-sw.js'),
  fs.readFileSync(new URL('./sw-template.js', import.meta.url), 'utf-8')
    .replace('__CONFIG__', JSON.stringify({
      buildId, scope, generatedAt: new Date().toISOString(), layers,
    }, null, 2))
    .replace('__OVERLAY__', JSON.stringify(overlaySrc)));

fs.writeFileSync(path.join(outDir, '__tirno-boot.html'),
  `<!doctype html><meta charset="utf-8"><title>tirno sw-proxy</title>\n<h1>tirno sw-proxy</h1>\n<p>${cfg.origin} · build ${buildId} · ${paths.length} paths · ${cfg.mounts.length} mounts</p>\n`);

// ── 로컬 TLS 서버. 부트스트랩 산출물과 마운트된 파일만 내려주면 된다.
//    마운트마다 root 가 다르므로 경로 표를 그대로 박는다.
fs.writeFileSync(path.join(outDir, 'serve.mjs'), `#!/usr/bin/env node
// 생성된 파일. 부트스트랩 동안에만 필요하다.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const MAP = ${JSON.stringify(Object.fromEntries(map), null, 2)};
// 레이어별 실제 파일. 겹치는 경로에서 각 레이어가 자기 것을 받아야 하므로,
// SW 가 install 때 ?__tirno_layer=<id> 로 물어본다.
const LAYERS = ${JSON.stringify(Object.fromEntries(layers.map(l => [l.id,
  Object.fromEntries(l.paths.map(p => [p, layerFile.get(l.id + '\u0000' + p)]))])), null, 2)};

// 워커가 자기 control 경로로 내는 스크립트다. 워커가 없으면 404 라서 창이 안 뜬다.
const OVERLAY_TAG = ${JSON.stringify(overlayOn
  ? `<script src="${scope}__tirno/overlay.js" defer></script>`
  : '')};

// 옵트인: mounts 목록 밖 요청을 진짜 origin 으로 릴레이한다. host-resolver 는
// 크롬 전용이라 이 node 서버는 OS DNS 로 진짜 origin 에 닿는다 — 자기 순환이 없다.
// 켜면 "목록 밖은 손대지 않는다" 규율이 깨지고 전 트래픽이 로컬을 경유한다.
const PASSTHROUGH = ${cfg.passthrough ? JSON.stringify(cfg.origin) : 'null'};

// SW 는 캐시된 응답의 헤더를 그대로 넘긴다 — 여기서 붙인 타입이 그대로 굳는다.
// 틀리면 브라우저가 거부한다: JS/CSS 는 nosniff 로 막히고, wasm 은
// instantiateStreaming 이 application/wasm 을 요구한다.
const TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.pdf': 'application/pdf',
};

https.createServer({
  cert: fs.readFileSync(path.join(DIR, 'cert.pem')),
  key: fs.readFileSync(path.join(DIR, 'key.pem')),
}, (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'https://x').pathname);
  const layer = new URL(req.url, 'https://x').searchParams.get('__tirno_layer');
  const boot = path.join(DIR, path.basename(p));          // 부트스트랩 산출물
  const file = (layer && LAYERS[layer] && LAYERS[layer][p])
    ?? MAP[p]
    ?? (fs.existsSync(boot) && fs.statSync(boot).isFile() ? boot : null);
  if (!file) {
    if (PASSTHROUGH) {
      const u = new URL(PASSTHROUGH);
      const up = https.request({
        host: u.hostname, port: u.port || 443, path: req.url, method: req.method,
        headers: { ...req.headers, host: u.host },   // Host 는 진짜 origin 으로 교정
        servername: u.hostname,
      }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', e => { res.statusCode = 502; res.end('relay error: ' + e.message); });
      console.log('→', req.method, p, '(relay)');
      return req.pipe(up);
    }
    console.log(res.statusCode = 404, p);
    return res.end('not found');
  }
  console.log(res.statusCode = 200, p);
  const ext = path.extname(file).toLowerCase();
  if (!TYPES[ext]) console.warn('  ! 모르는 확장자', ext, '— octet-stream 으로 나간다. 브라우저가 거부할 수 있다');
  res.setHeader('content-type', TYPES[ext] ?? 'application/octet-stream');

  // 확인 창의 태그는 **낼 때** 끼운다. 빌드 산출물 파일은 손대지 않는다 —
  // 원본을 고치면 다음 빌드가 덮어쓰거나, 고친 채로 배포될 수 있다.
  if (OVERLAY_TAG && (ext === '.html' || ext === '.htm')) {
    const html = fs.readFileSync(file, 'utf-8');
    const out = html.includes('</body>')
      ? html.replace('</body>', OVERLAY_TAG + '</body>')
      : html + OVERLAY_TAG;
    return res.end(out);
  }

  fs.createReadStream(file).pipe(res);
}).listen(${port}, '127.0.0.1', () => console.log('listening on https://127.0.0.1:${port}'));
`);

// ── 인증서는 있으면 다시 굽지 않는다. 매번 새로 만들 이유가 없다.
//
// 굽는 것은 openssl 이고 tirno 가 아니다. mkcert 로 구워도 되지만, 이 절차는
// `mkcert -install` 을 하지 않는다 — 신뢰는 --ignore-certificate-errors 로
// 그 크롬 세션에만 국한한다.
const cert = path.join(outDir, 'cert.pem');
if (!fs.existsSync(cert)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', path.join(outDir, 'key.pem'), '-out', cert, '-days', '365', '-nodes',
    '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`], { stdio: 'ignore' });
}

console.log(`생성 완료 — ${outDir}
  build ${buildId} · scope ${scope} · 레이어 ${layers.length} · 경로 ${paths.length}개
  (위에 있는 레이어가 이긴다)`);
for (const l of layers) {
  const fb = l.navigateFallback ? `, navigate ${l.navigateFallback}/* → 이 문서` : '';
  console.log(`    ${l.name.padEnd(16)} ${l.mount}  ←  ${l.from}  (${l.paths.length}${l.enabled ? '' : ', 꺼짐'}${fb})`);
}

console.log(`
다음:

  node ${path.relative(process.cwd(), path.join(outDir, 'serve.mjs'))} &
  tirno new <세션> --headless -- --host-resolver-rules="MAP ${host} 127.0.0.1:${port}" --ignore-certificate-errors
  tirno nav ${cfg.origin}${scope}__tirno-boot.html
  tirno eval "navigator.serviceWorker.register('${scope}__tirno-sw.js').then(r => r.scope)"
  tirno restart <세션>          # rule 없이 — 여기서부터 진짜 origin

scope 는 ${scope} 다 — 그 아래 문서를 열어야 SW 가 붙는다.

확인:    tirno eval 'fetch("${scope}__tirno/status").then(r => r.text())'
레이어:  tirno eval 'fetch("${scope}__tirno/unmount?layer=<이름>").then(r => r.text())'
         tirno eval 'fetch("${scope}__tirno/mount?layer=<이름>").then(r => r.text())'
해제:    tirno eval 'fetch("${scope}__tirno/off").then(r => r.text())'`);
