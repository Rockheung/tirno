#!/usr/bin/env node
// tirno sw-proxy — 설정 하나로 부트스트랩 산출물을 굽는다.
//
//   node scripts/sw-proxy/generate.mjs <mounts.json> [--out <dir>]
//
// 하는 일은 하나다: origin 의 지정한 경로를 로컬 빌드가 내게 만든다.
// 앱이 여럿이면 마운트를 여럿 적는다 — 서비스워커는 origin 당 하나지만,
// 그 하나가 여러 빌드를 나눠 낸다.
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

// ── 마운트를 편다.
//    { path: "/_/app/", root: "./app/dist" }  → 그 디렉터리 전부를 그 접두사 아래로
//    { path: "/vendor/x.js", file: "./x.js" } → 파일 하나
//
// origin 의 경로와 로컬 경로는 **다를 수 있다.** 앱의 dist 는 자기 루트가 `/` 지만
// origin 에서는 `/_/app/` 아래 사는 것이 보통이다 — 그 어긋남을 여기서 흡수한다.
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

const map = new Map();          // origin 경로 → 로컬 절대경로
const errors = [];
for (const [i, m] of cfg.mounts.entries()) {
  const label = m.path ?? `mounts[${i}]`;
  if (!m.path) { errors.push(`${label}: "path" 가 없다`); continue; }

  if (m.path.endsWith('/')) {
    if (!m.root) { errors.push(`${label}: 디렉터리 마운트에는 "root" 가 필요하다`); continue; }
    const root = path.resolve(cfgDir, m.root);
    if (!fs.existsSync(root)) { errors.push(`${label}: root 가 없다 — ${root}`); continue; }
    for (const f of walk(root)) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      const urlPath = m.path + rel;
      if (map.has(urlPath)) errors.push(`${urlPath}: 마운트가 겹친다`);
      map.set(urlPath, f);
    }
  } else {
    if (!m.file) { errors.push(`${label}: 파일 마운트에는 "file" 이 필요하다`); continue; }
    const file = path.resolve(cfgDir, m.file);
    if (!fs.existsSync(file)) { errors.push(`${label}: file 이 없다 — ${file}`); continue; }
    if (map.has(m.path)) errors.push(`${m.path}: 마운트가 겹친다`);
    map.set(m.path, file);
  }
}
if (errors.length) { console.error(errors.map(e => '✗ ' + e).join('\n')); process.exit(1); }
if (!map.size) { console.error('마운트가 아무 파일도 가리키지 않는다'); process.exit(1); }

const paths = [...map.keys()].sort();

// ── buildId — 경로와 그 내용에서 나온다. 무엇이든 바뀌면 activate 가 옛 캐시를 지운다.
const h = crypto.createHash('sha1');
for (const p of paths) h.update(p).update(fs.readFileSync(map.get(p)));
const buildId = h.digest('hex').slice(0, 12);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '__tirno-sw.js'),
  fs.readFileSync(new URL('./sw-template.js', import.meta.url), 'utf-8')
    .replace('__CONFIG__', JSON.stringify({ buildId, generatedAt: new Date().toISOString(), paths }, null, 2)));

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
  const boot = path.join(DIR, path.basename(p));          // 부트스트랩 산출물
  const file = MAP[p] ?? (fs.existsSync(boot) && fs.statSync(boot).isFile() ? boot : null);
  console.log(res.statusCode = file ? 200 : 404, p);
  if (!file) return res.end('not found');
  const ext = path.extname(file).toLowerCase();
  if (!TYPES[ext]) console.warn('  ! 모르는 확장자', ext, '— octet-stream 으로 나간다. 브라우저가 거부할 수 있다');
  res.setHeader('content-type', TYPES[ext] ?? 'application/octet-stream');
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
  build ${buildId} · 마운트 ${cfg.mounts.length} · 경로 ${paths.length}개`);
for (const m of cfg.mounts) {
  const n = paths.filter(p => (m.path.endsWith('/') ? p.startsWith(m.path) : p === m.path)).length;
  console.log(`    ${m.path}  ←  ${m.root ?? m.file}  (${n})`);
}
console.log(`
다음:

  node ${path.relative(process.cwd(), path.join(outDir, 'serve.mjs'))} &
  tirno new <세션> --headless -- --host-resolver-rules="MAP ${host} 127.0.0.1:${port}" --ignore-certificate-errors
  tirno nav ${cfg.origin}/__tirno-boot.html
  tirno eval "navigator.serviceWorker.register('/__tirno-sw.js').then(r => r.scope)"
  tirno restart <세션>          # rule 없이 — 여기서부터 진짜 origin

확인:  tirno eval 'fetch("/__tirno/status").then(r => r.text())'
해제:  tirno eval 'fetch("/__tirno/off").then(r => r.text())'`);
