// `intercept` 스모크용 최소 오리진.
//
// 가로채기는 **서버가 무엇을 못 받았는가**로만 증명된다. 페이지 쪽만 보면 "차단됐다"와
// "원본이 원래 그렇게 답했다"를 못 가른다. 그래서 받은 요청을 JSONL 로 append 하고,
// 스모크는 그 파일을 truncate 해서 구간을 나눈다 — 메모리에 들고 있으면 파일을 지워도
// 안 비워져서, 옛 기록이 다음 구간의 결론을 오염시킨다(실측으로 두 번 밟았다).
//
// 포트는 0 으로 받아 실제 값을 파일에 적는다. 고정 포트는 CI 에서 남과 부딪힌다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  process.stderr.write('intercept-server: <outDir> required\n');
  process.exit(2);
}
const logFile = path.join(outDir, 'requests.jsonl');
const portFile = path.join(outDir, 'port');

const PAGE = `<!doctype html><meta charset=utf-8><title>intercept fixture</title>
<img id=ad src="/ads/banner.png" alt="">
<p id=api>pending</p>
<script>
fetch('/api/user').then(r => r.json()).then(j => { document.getElementById('api').textContent = JSON.stringify(j); })
  .catch(e => { document.getElementById('api').textContent = 'ERR'; });
</script>`;

const server = http.createServer((req, res) => {
  const p = (req.url ?? '/').split('?')[0];
  try {
    fs.appendFileSync(logFile, JSON.stringify({ path: p, xTirno: req.headers['x-tirno'] ?? null }) + '\n');
  } catch { /* 기록 실패가 서빙을 막지는 않는다 */ }

  if (p === '/api/user') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ from: 'origin' }));
    return;
  }
  if (p.startsWith('/ads/')) {
    res.setHeader('content-type', 'image/png');
    // 1x1 PNG — 차단되지 않았다면 naturalWidth 가 1 이 된다.
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(PAGE);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(portFile, String(port));
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
