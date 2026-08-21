#!/usr/bin/env node
// tirno sw-proxy — 규칙 파일 하나로 부트스트랩 산출물을 굽는다.
//
//   node scripts/sw-proxy/generate.mjs <serve.json> [--out <dir>]
//
// 하는 일은 하나다: 지정한 origin 경로들을 로컬 빌드에서 내게 만든다.
// 나오는 것 — __tirno-sw.js · __tirno-boot.html · serve.mjs · cert.pem/key.pem
// 그다음 칠 명령도 찍어 준다.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const cfgPath = args.find(a => !a.startsWith('--'));
if (!cfgPath) {
  console.error('사용법: node scripts/sw-proxy/generate.mjs <serve.json> [--out <dir>]');
  process.exit(1);
}
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.dirname(path.resolve(cfgPath));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

for (const k of ['origin', 'root', 'serve']) {
  if (!cfg[k]) { console.error(`설정에 "${k}" 가 없다`); process.exit(1); }
}
const host = new URL(cfg.origin).hostname;
const port = cfg.port ?? 8443;
const root = path.resolve(path.dirname(path.resolve(cfgPath)), cfg.root);
if (!fs.existsSync(root)) { console.error(`root 가 없다: ${root}`); process.exit(1); }

// ── serve 목록을 실제 경로로 편다.
//    `/` 로 끝나면 그 아래 전부, 아니면 그 파일 하나. 둘 다 root 안에 있어야 한다.
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const rel = f => '/' + path.relative(root, f).split(path.sep).join('/');

const paths = [];
const missing = [];
for (const entry of cfg.serve) {
  const local = path.join(root, entry);
  if (entry.endsWith('/')) {
    if (!fs.existsSync(local)) { missing.push(entry); continue; }
    paths.push(...walk(local).map(rel));
  } else {
    if (!fs.existsSync(local)) { missing.push(entry); continue; }
    paths.push(entry);
  }
}
if (missing.length) {
  console.error(`root 에 없는 항목: ${missing.join(', ')}`);
  process.exit(1);
}
if (!paths.length) { console.error('serve 가 비어 있다'); process.exit(1); }

// ── buildId — 경로와 그 내용에서 나온다. 무엇이든 바뀌면 activate 가 옛 캐시를 지운다.
const h = crypto.createHash('sha1');
for (const p of paths.sort()) h.update(p).update(fs.readFileSync(path.join(root, p)));
const buildId = h.digest('hex').slice(0, 12);

fs.mkdirSync(outDir, { recursive: true });
const swConfig = { buildId, generatedAt: new Date().toISOString(), paths };
fs.writeFileSync(path.join(outDir, '__tirno-sw.js'),
  fs.readFileSync(new URL('./sw-template.js', import.meta.url), 'utf-8')
    .replace('__CONFIG__', JSON.stringify(swConfig, null, 2)));

fs.writeFileSync(path.join(outDir, '__tirno-boot.html'),
  `<!doctype html><meta charset="utf-8"><title>tirno sw-proxy</title>\n<h1>tirno sw-proxy</h1>\n<p>${cfg.origin} · build ${buildId} · ${paths.length} paths</p>\n`);

// ── 로컬 TLS 서버. 부트스트랩 페이지와 SW, 그리고 serve 대상만 내려주면 된다.
fs.writeFileSync(path.join(outDir, 'serve.mjs'), `#!/usr/bin/env node
// 생성된 파일. 부트스트랩 동안에만 필요하다.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = ${JSON.stringify(root)};
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
  const local = path.join(DIR, path.basename(p));      // 부트스트랩 산출물
  const fromRoot = path.join(ROOT, p);                 // 빌드 산출물
  const file = fs.existsSync(local) && fs.statSync(local).isFile() ? local
             : fs.existsSync(fromRoot) && fs.statSync(fromRoot).isFile() ? fromRoot : null;
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
// 굽는 것은 openssl 이고 tirno 가 아니다. mkcert 로 구워도 상관없지만
// `mkcert -install` 은 하지 않는다 — 아래 경고 참고.
const cert = path.join(outDir, 'cert.pem');
if (!fs.existsSync(cert)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', path.join(outDir, 'key.pem'), '-out', cert, '-days', '365', '-nodes',
    '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`], { stdio: 'ignore' });
}

// ── 원칙: 로컬 CA 를 신뢰 저장소에 넣지 않는다.
//
// 신뢰는 --ignore-certificate-errors 로 그 크롬 세션에만 국한한다. 로컬 CA 가 신뢰
// 저장소에 들어가면 아무 도메인 인증서나 발급할 수 있는 권한이 생기고, 그 개인키는
// 디스크에 평문으로 남는다 — 부트스트랩 몇 초를 편하려고 시스템 전역에 만능 발급권을
// 심는 셈이다. 글로만 적어두면 안 지켜지므로 여기서 본다.
if (process.platform === 'darwin') {
  const found = [];
  for (const name of ['mkcert', 'mitmproxy', 'Proxyman', 'Charles', 'Fiddler']) {
    try {
      execFileSync('security', ['find-certificate', '-c', name], { stdio: 'ignore' });
      found.push(name);
    } catch { /* 없음 — 정상 */ }
  }
  if (found.length) {
    console.warn(`
⚠  키체인에 로컬 CA 가 있다: ${found.join(', ')}
   그 CA 는 아무 도메인 인증서나 발급할 수 있고 개인키는 디스크에 있다.
   이 절차는 --ignore-certificate-errors 로 그 크롬 세션에만 신뢰를 국한하므로
   신뢰 저장소에 넣을 필요가 없다. 쓰지 않는다면 빼는 게 맞다:
     security find-certificate -a -c <이름>      # 확인
     mkcert -uninstall                           # mkcert 인 경우
`);
  }
}

const shown = paths.slice(0, 5).join('  ');
console.log(`생성 완료 — ${outDir}
  build ${buildId} · 경로 ${paths.length}개
  ${shown}${paths.length > 5 ? `  … 외 ${paths.length - 5}` : ''}

다음:

  node ${path.relative(process.cwd(), path.join(outDir, 'serve.mjs'))} &
  tirno new <세션> --headless -- --host-resolver-rules="MAP ${host} 127.0.0.1:${port}" --ignore-certificate-errors
  tirno nav ${cfg.origin}/__tirno-boot.html
  tirno eval "navigator.serviceWorker.register('/__tirno-sw.js').then(r => r.scope)"
  tirno restart <세션>          # rule 없이 — 여기서부터 진짜 origin

확인:  tirno eval 'fetch("/__tirno/status").then(r => r.text())'
해제:  tirno eval 'fetch("/__tirno/off").then(r => r.text())'`);
