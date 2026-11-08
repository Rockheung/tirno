/**
 * Safari 세션 — safaridriver 의 WebDriver BiDi 를 직접 말한다.
 *
 * 기본은 Safari Technology Preview 다. 사용자가 쓰는 Safari 와 따로 떠서, Safari 가 열려
 * 있어도 자동화 세션이 열린다(실측: STP 256 에서 2초 안). 일반 Safari 의 safaridriver 는
 * Safari 가 떠 있으면 세션 생성이 시간 초과되고, BiDi 도 탐색·평가만 된다.
 *
 * Web Inspector 프로토콜(`com.apple.webinspector.debugger`)은 Apple 비공개 권한이 있는
 * 프로그램만 붙을 수 있어 쓰지 않는다 — 권한 없는 연결은 webinspectord 가 바로 끊는다(실측).
 *
 * safaridriver 는 동시에 세션 하나만 연다. BiDi 연결은 끊었다 다시 붙어도 세션이 남으므로
 * Firefox 와 달리 연결을 붙잡는 상주 프로세스가 없다.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as store from './session-store.js';
import { isAlive } from './process-guard.js';
import { openBidiPage } from './firefox.js';
import { TirnoError } from '../util/errors.js';

const STP_DRIVER = '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver';

export function findSafariDriver(explicit?: string): string {
  const candidate = explicit ?? process.env['TIRNO_SAFARI'] ?? STP_DRIVER;
  if (fs.existsSync(candidate)) return candidate;
  throw new TirnoError(explicit || process.env['TIRNO_SAFARI']
    ? `No safaridriver at ${candidate}`
    : 'Safari Technology Preview is not installed — get it from https://developer.apple.com/safari/resources/, or point --executable-path at /usr/bin/safaridriver (Safari itself must then be closed)',
  'safari_not_found');
}

function browserNameFor(driver: string): string {
  return driver.includes('Safari Technology Preview') ? 'Safari Technology Preview' : 'safari';
}

/** 명령줄이 이 세션의 드라이버인가 — Safari 에는 프로필이 없어 포트로 가른다 */
export function isSafariDriverFor(cmdline: string, port: number): boolean {
  return /safaridriver(\s|$)/.test(cmdline) && new RegExp(`(^|\\s)-p\\s+${port}(\\s|$)`).test(cmdline);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function webdriver<T>(port: number, method: string, route: string, body?: unknown, timeoutMs = 60000): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json() as { value: T & { error?: string; message?: string } };
  if (json.value?.error) throw new TirnoError(`safaridriver: ${json.value.message ?? json.value.error}`, 'safari_error');
  return json.value;
}

export interface SafariLaunch {
  name: string;
  executablePath?: string;
  bootUrl?: string;
}

export async function launchSafari(opts: SafariLaunch): Promise<store.SessionMetadata> {
  const live = store.list().find(s => s.engine === 'safari' && isAlive(s.pid));
  if (live) throw new TirnoError(`safaridriver runs one session at a time and '${live.name}' holds it — \`tirno kill ${live.name}\` first`, 'capability_unsupported', { engine: 'safari', session: live.name });

  const driver = findSafariDriver(opts.executablePath);
  const userDataDir = store.profileDir(opts.name);
  fs.mkdirSync(userDataDir, { recursive: true });
  const port = await freePort();
  const child = spawn(driver, ['-p', String(port)], { detached: true, stdio: ['ignore', 'ignore', fs.openSync(path.join(userDataDir, 'safaridriver.log'), 'a')] });
  child.unref();
  let meta: store.SessionMetadata;
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      try { await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) }); break; } catch { /* 아직 안 열렸다 */ }
      if (Date.now() >= deadline) throw new TirnoError(`safaridriver did not listen on ${port} within 10s`, 'safari_error');
      await new Promise(r => setTimeout(r, 100));
    }
    const session = await webdriver<{ sessionId: string; capabilities: { webSocketUrl?: string } }>(port, 'POST', '/session', {
      // 로컬 하네스는 대개 mkcert 같은 자체 인증서다 — 경고 화면에 막히지 않게 세 엔진 모두 받는다
      capabilities: { alwaysMatch: { browserName: browserNameFor(driver), webSocketUrl: true, 'safari:experimentalWebSocketUrl': true, acceptInsecureCerts: true } },
    });
    if (!session.capabilities.webSocketUrl) throw new TirnoError('safaridriver opened a session without WebDriver BiDi', 'safari_error');
    const now = new Date().toISOString();
    meta = {
      name: opts.name, engine: 'safari', pid: child.pid!, port, wsEndpoint: session.capabilities.webSocketUrl,
      webdriverSessionId: session.sessionId, userDataDir, chromeFlags: [], headless: false,
      ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
      createdAt: now, lastAccessedAt: now,
    };
  } catch (e) {
    child.kill();
    throw e;
  }
  // 여기서부터는 세션이 있다 — 부트 URL 이 실패해도 세션은 남긴다(Firefox 와 같다)
  store.create(meta);
  store.setActive(opts.name);
  if (opts.bootUrl) {
    const { page, browser } = await openBidiPage(meta);
    try { await page.goto(opts.bootUrl); } finally { browser.disconnect(); }
  }
  return meta;
}

/** 드라이버를 죽이기 전에 세션을 닫는다 — 그래야 자동화 창이 남지 않는다 */
export async function endSafariSession(meta: store.SessionMetadata): Promise<void> {
  if (meta.engine !== 'safari' || !meta.webdriverSessionId || !isAlive(meta.pid)) return;
  try { await webdriver(meta.port, 'DELETE', `/session/${meta.webdriverSessionId}`, undefined, 5000); } catch { /* 이미 닫혔다 */ }
}
