// `tirno intercept` 의 상주 워커.
//
// 왜 데몬인가: 호스트별 헤더·모킹·차단은 **요청마다 응답을 보내야** 한다. tirno 는
// 명령마다 CDP 를 붙였다 끊으므로 CLI 한 방으로는 안 되고, `cdp --listen` 은 이벤트를
// 받아 출력만 하지 응답을 못 보낸다 (#122). screencast·trace 와 같은 모양의 워커다.
//
// 규칙은 세션 메타에 산다. 워커는 그것을 읽고, **파일이 바뀌면 다시 읽는다** — 규칙을
// 하나 더할 때마다 데몬을 재기동하게 만들면 그 사이 요청이 규칙 없이 지나간다.
//
// 히트 수는 `<out>/stats.json` 에 쓴다. "규칙을 걸었는데 안 먹는다" 와 "걸렸는데 그
// 요청이 안 왔다" 는 다른 문제이고, 그 둘을 가르는 것은 카운터뿐이다.

import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core';
import { resolve, type InterceptRule } from '../core/intercept-store.js';

interface Args { ws: string; out: string; rulesFile: string }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ws = get('--ws') ?? '';
  const out = get('--out') ?? '';
  const rulesFile = get('--rules') ?? '';
  if (!ws || !out || !rulesFile) {
    process.stderr.write('intercept-worker: --ws, --out and --rules required\n');
    process.exit(2);
  }
  return { ws, out, rulesFile };
}

/** 규칙 캐시. mtime 이 바뀌었을 때만 다시 읽는다 — 요청마다 파일을 여는 것은 비싸다. */
function makeRuleReader(rulesFile: string): () => InterceptRule[] {
  let cached: InterceptRule[] = [];
  let stamp = -1;
  return () => {
    let mtime: number;
    try { mtime = fs.statSync(rulesFile).mtimeMs; } catch { return cached; }
    if (mtime !== stamp) {
      stamp = mtime;
      try {
        cached = (JSON.parse(fs.readFileSync(rulesFile, 'utf-8')) as { intercept?: InterceptRule[] }).intercept ?? [];
      } catch {
        // 반쯤 쓰인 파일을 읽었을 수 있다. 다음 tick 에 다시 본다 — 옛 규칙으로 도는
        // 것이 규칙 없이 도는 것보다 낫다.
        stamp = -1;
      }
    }
    return cached;
  };
}

function guessContentType(body: string): string {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'application/json; charset=utf-8';
  if (trimmed.startsWith('<')) return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

async function main(): Promise<void> {
  const args = parseArgs();
  const readRules = makeRuleReader(args.rulesFile);
  const hits: Record<string, number> = {};
  let seen = 0;

  const flush = (): void => {
    try {
      fs.writeFileSync(path.join(args.out, 'stats.json'), JSON.stringify({
        pid: process.pid, seen, hits, updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch { /* best-effort */ }
  };

  const browser: Browser = await puppeteer.connect({
    browserWSEndpoint: args.ws,
    defaultViewport: null,
  });

  const handle = async (req: HTTPRequest): Promise<void> => {
    seen++;
    const { headers, terminal, matched } = resolve(readRules(), req.url());
    for (const rule of matched) hits[rule.id] = (hits[rule.id] ?? 0) + 1;
    try {
      if (terminal?.kind === 'block') {
        await req.abort('blockedbyclient');
        return;
      }
      if (terminal?.kind === 'mock') {
        const body = terminal.body ?? '';
        await req.respond({
          status: terminal.status ?? 200,
          contentType: terminal.contentType ?? guessContentType(body),
          body,
        });
        return;
      }
      // 헤더는 있는 것 위에 얹는다. 지우지 않는다. 걸린 헤더 규칙이 없으면 빈 객체라
      // 요청이 그대로 나간다.
      await req.continue({ headers: { ...req.headers(), ...headers } });
    } catch {
      // 이미 처리된 요청이거나 페이지가 사라졌다. 어느 쪽이든 이 요청은 끝났다.
    }
  };

  const wire = async (page: Page): Promise<void> => {
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => { void handle(req); });
    } catch { /* 닫히는 중인 페이지 */ }
  };

  for (const page of await browser.pages()) await wire(page);
  // 나중에 열리는 탭도 같은 규칙을 받아야 한다 — 안 그러면 `new-tab` 하나로 규칙이 샌다.
  browser.on('targetcreated', (target) => {
    void target.page().then(p => p && wire(p)).catch(() => { /* 페이지 타깃이 아니다 */ });
  });

  const timer = setInterval(flush, 1000);
  timer.unref?.();
  flush();

  const stop = (): void => {
    flush();
    try { browser.disconnect(); } catch { /* 이미 끊겼다 */ }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  // 브라우저가 먼저 죽으면 워커도 남을 이유가 없다.
  browser.on('disconnected', stop);
}

main().catch((e: Error) => {
  process.stderr.write(`intercept-worker: ${e.message}\n`);
  process.exit(1);
});
