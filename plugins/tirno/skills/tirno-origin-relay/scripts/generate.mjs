#!/usr/bin/env node
// tirno origin-relay — 설정 하나로 로컬 릴레이 서버를 굽는다.
//
//   node generate.mjs <mounts.json> [--out <dir>]
//
// 서비스워커를 안 쓴다. host-resolver 로 크롬의 그 origin 요청을 이 서버로 돌리고,
// 서버가 목록 안은 로컬 빌드, 목록 밖은 진짜 origin 으로 릴레이한다. 지연 등록 SW·
// 로그인 뒤 화면처럼 host-resolver 를 세션 내내 켜 둬야 하는 경우에 쓴다.
//
// 나오는 것 — serve.mjs · cert.pem/key.pem  (SW·부트 페이지·확인 창은 없다)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const cfgPath = args.find(a => !a.startsWith('--'));
if (!cfgPath) {
  console.error('사용법: node generate.mjs <mounts.json> [--out <dir>]');
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

// ── 마운트를 편다.
//    { path: "/_/app/", root: "./app/dist" }  → 그 디렉터리 전부를 그 접두사 아래로
//    { path: "/app", file: "./dist/index.html", navigateFallback: "/app" } → 파일 하나
//
// origin 의 경로와 로컬 경로는 다를 수 있다 — 앱의 dist 는 자기 루트가 `/` 지만
// origin 에서는 `/_/app/` 아래 사는 것이 보통이다. 그 어긋남을 여기서 흡수한다.
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

const map = new Map();          // origin 경로 → 로컬 절대경로
const fallbacks = [];           // { prefix, file } — SPA navigate 하위 경로용
const errors = [];
for (const [i, m] of cfg.mounts.entries()) {
  const label = m.path ?? `mounts[${i}]`;
  if (!m.path) { errors.push(`${label}: "path" 가 없다`); continue; }

  // 배포 서버가 그 자산에 붙이던 헤더는 릴레이 경로에서만 살아남는다(origin 응답을
  // 그대로 넘기므로). 마운트한 것은 여기서 다시 선언해야 한다 — 안 그러면 마운트한
  // 것만 CORS 를 잃어 브라우저가 거부한다(#159).
  let headers;
  if (m.headers !== undefined) {
    const h = m.headers;
    if (typeof h !== 'object' || h === null || Array.isArray(h)) {
      errors.push(`${label}: headers 는 객체여야 한다`); continue;
    }
    const bad = Object.entries(h).filter(([, v]) => typeof v !== 'string');
    if (bad.length) {
      errors.push(`${label}: headers 값은 문자열이어야 한다 — ${bad.map(([k]) => k).join(', ')}`); continue;
    }
    if (Object.keys(h).length) headers = h;
  }

  // navigateFallback 은 낼 문서가 하나로 정해질 때만 뜻이 있다.
  let navigateFallback;
  if (m.navigateFallback !== undefined) {
    if (m.path.endsWith('/')) {
      errors.push(`${label}: navigateFallback 은 파일 마운트에만 쓴다`); continue;
    }
    if (typeof m.navigateFallback !== 'string' || !m.navigateFallback.startsWith('/')) {
      errors.push(`${label}: navigateFallback 은 "/" 로 시작하는 경로여야 한다`); continue;
    }
    navigateFallback = m.navigateFallback;
  }

  if (m.path.endsWith('/')) {
    if (!m.root) { errors.push(`${label}: 디렉터리 마운트에는 "root" 가 필요하다`); continue; }
    const root = path.resolve(cfgDir, m.root);
    if (!fs.existsSync(root)) { errors.push(`${label}: root 가 없다 — ${root}`); continue; }
    for (const f of walk(root)) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      const urlPath = m.path + rel;
      if (!map.has(urlPath)) map.set(urlPath, { file: f, ...(headers ? { headers } : {}) });   // 먼저 선언한 마운트가 이긴다
    }
  } else {
    if (!m.file) { errors.push(`${label}: 파일 마운트에는 "file" 이 필요하다`); continue; }
    const file = path.resolve(cfgDir, m.file);
    if (!fs.existsSync(file)) { errors.push(`${label}: file 이 없다 — ${file}`); continue; }
    if (!map.has(m.path)) map.set(m.path, { file, ...(headers ? { headers } : {}) });
    if (navigateFallback) fallbacks.push({ prefix: navigateFallback, file, ...(headers ? { headers } : {}) });
  }
}
if (errors.length) { console.error(errors.map(e => '✗ ' + e).join('\n')); process.exit(1); }
if (!map.size) { console.error('마운트가 아무 파일도 가리키지 않는다'); process.exit(1); }

fs.mkdirSync(outDir, { recursive: true });

// ── 로컬 TLS 서버. 목록 안은 로컬, 목록 밖은 진짜 origin 으로 릴레이한다.
fs.writeFileSync(path.join(outDir, 'serve.mjs'), `#!/usr/bin/env node
// 생성된 파일. host-resolver 를 이 서버로 돌린 세션 내내 돈다.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const MAP = ${JSON.stringify(Object.fromEntries(map), null, 2)};

// SPA 하위 경로의 navigate 요청을 이 문서로 받는다 — 아니면 릴레이로 새서 배포본을
// 받는다(로그인 리다이렉트가 하위 경로 착지). 자산은 이 규칙을 안 탄다.
const FALLBACKS = ${JSON.stringify(fallbacks, null, 2)};
const underPrefix = (pathname, prefix) =>
  pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');

// host-resolver 는 크롬 전용이라 이 node 서버는 OS DNS 로 진짜 origin 에 닿는다 —
// 목록 밖을 origin 으로 릴레이해도 자기 자신으로 순환하지 않는다.
const ORIGIN = ${JSON.stringify(cfg.origin)};

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
  let hit = MAP[p] ?? null;
  // navigate 요청이 목록에 없고 navigateFallback 접두사 아래면 그 문서를 낸다.
  if (!hit && req.headers['sec-fetch-mode'] === 'navigate') {
    const fb = FALLBACKS.find(f => underPrefix(p, f.prefix));
    if (fb) hit = fb;
  }
  if (!hit) {
    // 목록 밖 → 진짜 origin 으로 릴레이.
    const u = new URL(ORIGIN);
    const up = https.request({
      host: u.hostname, port: u.port || 443, path: req.url, method: req.method,
      headers: { ...req.headers, host: u.host },   // Host 는 진짜 origin 으로 교정
      servername: u.hostname,
    }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', e => { res.statusCode = 502; res.end('relay error: ' + e.message); });
    console.log('→', req.method, p, '(relay)');
    return req.pipe(up);
  }
  console.log(res.statusCode = 200, p);
  const ext = path.extname(hit.file).toLowerCase();
  if (!TYPES[ext]) console.warn('  ! 모르는 확장자', ext, '— octet-stream 으로 나간다');
  res.setHeader('content-type', TYPES[ext] ?? 'application/octet-stream');
  // 마운트가 선언한 헤더는 뒤에 얹는다 — 확장자 추측을 덮을 수 있어야 한다.
  for (const [k, v] of Object.entries(hit.headers ?? {})) res.setHeader(k, v);
  fs.createReadStream(hit.file).pipe(res);
}).listen(${port}, '127.0.0.1', () => console.log('listening on https://127.0.0.1:${port}'));
`);

// ── 인증서는 있으면 다시 굽지 않는다. openssl 이 굽고, 신뢰는
//    --ignore-certificate-errors 로 그 크롬 세션에만 국한한다.
const cert = path.join(outDir, 'cert.pem');
if (!fs.existsSync(cert)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', path.join(outDir, 'key.pem'), '-out', cert, '-days', '365', '-nodes',
    '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`], { stdio: 'ignore' });
}

console.log(`생성 완료 — ${outDir}
  origin ${cfg.origin} · 마운트 경로 ${map.size}개 · navigateFallback ${fallbacks.length}개`);
console.log(`
다음 (host-resolver 를 세션 내내 켜 둔다 — restart 로 떼지 않는다):

  node ${path.relative(process.cwd(), path.join(outDir, 'serve.mjs'))} &
  tirno new <세션> --headless -- --host-resolver-rules="MAP ${host} 127.0.0.1:${port}" --ignore-certificate-errors
  tirno nav ${cfg.origin}/…       # 로그인·API 는 릴레이로 살아 있다

관측은 serve.log 뿐: "200 <경로>" = 로컬, "→ <경로> (relay)" = origin.`);
