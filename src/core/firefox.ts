import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { isRunnable } from './chrome-finder.js';
import { isAlive } from './process-guard.js';
import { selfArgs } from './update.js';
import * as store from './session-store.js';
import { requestedTab, tabHandle } from './tab-request.js';
import { TirnoError } from '../util/errors.js';
import type { ScreenshotOptions } from '../cdp/page.js';

/**
 * Firefox 를 외부 드라이버 없이 직접 말한다.
 *
 * 세션은 Marionette 로 만든다. `/session` 으로 직접 만든 BiDi 세션은 연결이 끊기면
 * 복구되지 않지만, Marionette 세션은 소켓이 살아 있는 동안 BiDi 재연결을 받는다.
 * 소켓은 상주 프로세스가 쥐고, CLI 는 명령마다 BiDi 에 붙는다.
 */

const CANDIDATES = [
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
  '/snap/bin/firefox',
];
const PREFS = [
  'user_pref("marionette.port", 0);',
  'user_pref("browser.startup.page", 0);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
];
const WAIT_MS = 30000;

export function findFirefox(explicit?: string): string {
  const chosen = explicit ?? process.env['TIRNO_FIREFOX'];
  if (chosen) {
    if (!isRunnable(chosen)) throw new TirnoError(`Not an executable file: ${chosen}`, 'firefox_not_found');
    return chosen;
  }
  const found = CANDIDATES.find(isRunnable);
  if (!found) throw new TirnoError(`Firefox not found. Looked in: ${CANDIDATES.join(', ')}. Use --executable-path or $TIRNO_FIREFOX`, 'firefox_not_found');
  return found;
}

export function firefoxArgs(profile: string, headless: boolean): string[] {
  return ['--no-remote', '--profile', profile, '--marionette', '--remote-debugging-port=0',
    '--width', '1920', '--height', '1080', ...(headless ? ['--headless'] : [])];
}

export function parseFirefoxProfile(cmdline: string): string | null {
  return /--profile (.+?)(?= --|$)/.exec(cmdline)?.[1] ?? null;
}

/** Marionette 는 `<길이>:<JSON>` 을 이어 보낸다. 길이는 바이트다. */
export function readFrames(buf: Buffer): { frames: unknown[]; rest: Buffer } {
  const frames: unknown[] = [];
  let rest = buf;
  for (;;) {
    const colon = rest.indexOf(58);
    if (colon < 0) break;
    const end = colon + 1 + Number(rest.subarray(0, colon).toString());
    if (rest.length < end) break;
    frames.push(JSON.parse(rest.subarray(colon + 1, end).toString()));
    rest = rest.subarray(end);
  }
  return { frames, rest };
}

async function waitFor<T>(what: string, read: () => T | null | undefined): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new TirnoError(`Timed out waiting for ${what}`, 'timeout');
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Marionette 소켓을 끝까지 쥔다. 소켓이 닫히면 세션이 끝나므로 이 프로세스도 끝난다. */
export async function holdSession(port: number, out: string): Promise<void> {
  const socket = net.connect(port, '127.0.0.1');
  let buf: Buffer = Buffer.alloc(0);
  let greeted = false;
  socket.on('close', () => process.exit(0));
  socket.on('error', () => process.exit(1));
  socket.on('data', chunk => {
    const { frames, rest } = readFrames(Buffer.concat([buf, chunk]));
    buf = rest;
    for (const frame of frames) {
      if (!greeted) {
        greeted = true;
        const body = JSON.stringify([0, 1, 'WebDriver:NewSession', { webSocketUrl: true, acceptInsecureCerts: true }]);
        socket.write(`${Buffer.byteLength(body)}:${body}`);
        continue;
      }
      const [, , error, result] = frame as [number, number, { message?: string } | null, { capabilities?: { webSocketUrl?: string } }];
      const webSocketUrl = result?.capabilities?.webSocketUrl;
      if (error || !webSocketUrl) process.exit(1);
      fs.writeFileSync(`${out}.tmp`, webSocketUrl);
      fs.renameSync(`${out}.tmp`, out);
    }
  });
  await new Promise(() => {});
}

function holderFile(profile: string): string {
  return path.join(profile, 'tirno-bidi-url');
}

async function startHolder(profile: string, port: number): Promise<string> {
  const file = holderFile(profile);
  fs.rmSync(file, { force: true });
  spawn(process.execPath, selfArgs(['__firefox-holder', String(port), file]), { detached: true, stdio: 'ignore' }).unref();
  return waitFor('the Firefox session', () => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);
}

export interface FirefoxLaunch {
  name: string;
  headless: boolean;
  executablePath?: string;
  userDataDir?: string;
  extraArgs: string[];
  bootUrl?: string;
}

export async function launchFirefox(opts: FirefoxLaunch): Promise<store.SessionMetadata> {
  const binary = findFirefox(opts.executablePath);
  const userDataDir = opts.userDataDir ?? store.profileDir(opts.name);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'user.js'), PREFS.join('\n') + '\n');
  const portFile = path.join(userDataDir, 'MarionetteActivePort');
  fs.rmSync(portFile, { force: true });

  const child = spawn(binary, [...firefoxArgs(userDataDir, opts.headless), ...opts.extraArgs], { detached: true, stdio: 'ignore' });
  child.unref();
  const { port, wsEndpoint } = await (async () => {
    const port = await waitFor('Marionette to listen', () => fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, 'utf-8')) : null);
    return { port, wsEndpoint: await startHolder(userDataDir, port) };
  })().catch((e: unknown) => {
    child.kill();
    throw e;
  });

  const now = new Date().toISOString();
  const meta: store.SessionMetadata = {
    name: opts.name, engine: 'firefox', pid: child.pid!, port, wsEndpoint, userDataDir,
    chromeFlags: opts.extraArgs, headless: opts.headless,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    createdAt: now, lastAccessedAt: now,
  };
  store.create(meta);
  store.setActive(opts.name);
  if (opts.bootUrl) {
    const { page, browser } = await openBidiPage(meta);
    await page.goto(opts.bootUrl);
    browser.disconnect();
  }
  return meta;
}

class Bidi {
  // safaridriver 는 응답을 연결이 아니라 요청 id 로만 짝짓는다 — 프로세스마다 1 부터 세면 한 세션을
  // 동시에 쓰는 두 tirno 가 같은 id 를 보내 한쪽이 응답을 잃는다(실측). 시작을 흩뜨린다.
  // safaridriver 는 id 를 32비트 부호 있는 정수로 읽어 2^31 이상에는 답하지 않는다(실측).
  private id = randomInt(1, 2 ** 31 - 2 ** 20);
  private readonly waiting = new Map<number, (m: BidiReply) => void>();
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data)) as BidiReply;
      if (m.id !== undefined) this.waiting.get(m.id)?.(m);
    };
  }

  static open(url: string): Promise<Bidi> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Bidi(ws));
      ws.onerror = () => reject(new Error(`Could not connect to ${url}`));
    });
  }

  async send<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.id;
    const reply = await new Promise<BidiReply>(resolve => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    this.waiting.delete(id);
    if (reply.type === 'error') throw new TirnoError(`${method}: ${reply.message ?? reply.error}`, 'firefox_error');
    return reply.result as T;
  }

  close(): void {
    this.ws.close();
  }
}

interface BidiReply { id?: number; type: string; result?: unknown; error?: string; message?: string }
interface EvalResult {
  type: 'success' | 'exception';
  result?: { value?: string };
  exceptionDetails?: { text?: string; exception?: { value?: { message?: string } } };
}

export type ClassicCall = <T>(method: 'POST' | 'DELETE', route: string, body?: unknown) => Promise<T>;

/** 프로세스 사이 잠금 — 디렉터리 생성이 원자적이라는 것에 기댄다. 30초 넘은 잠금은 죽은 것으로 본다 */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60000;
  for (;;) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 30000) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 방금 풀렸다 */ }
      if (Date.now() >= deadline) throw new TirnoError(`another command is still using this session's input (${dir})`, 'timeout');
      await new Promise(r => setTimeout(r, 50));
    }
  }
  try { return await fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export class FirefoxPage {
  constructor(private readonly bidi: Bidi, readonly context: string, private currentUrl: string,
    /** Safari 세션 — 입력은 classic WebDriver 로 보낸다(BiDi 는 포인터를 못 받고, 키는 OS 입력기를 탄다) */
    readonly webdriver?: { port: number; session: string; lock: string }) {}

  /**
   * classic WebDriver 호출 묶음. classic 은 세션에 "현재 창" 이 하나뿐이라, 이 탭으로 바꾸고
   * 입력을 끝낼 때까지 세션 잠금을 쥔다 — 다른 탭을 쓰는 명령이 사이에 끼어들지 않는다.
   */
  async withClassic<T>(fn: (call: ClassicCall) => Promise<T>): Promise<T> {
    const wd = this.webdriver;
    if (!wd) throw new TirnoError('classic WebDriver is only for Safari sessions', 'error');
    const call: ClassicCall = async <R>(method: 'POST' | 'DELETE', route: string, body?: unknown): Promise<R> => {
      const res = await fetch(`http://127.0.0.1:${wd.port}/session/${wd.session}${route}`, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
      });
      const { value } = await res.json() as { value: R & { error?: string; message?: string } };
      if (value && typeof value === 'object' && 'error' in value && value.error) throw new TirnoError(`safaridriver: ${value.message ?? value.error}`, 'safari_error');
      return value;
    };
    return withLock(wd.lock, async () => {
      await call('POST', '/window', { handle: this.context });
      return fn(call);
    });
  }

  /** 실제 입력 장치 동작. 끝나면 눌린 키·버튼을 놓는다 */
  async perform(actions: unknown[]): Promise<void> {
    await this.bidi.send('input.performActions', { context: this.context, actions });
    await this.bidi.send('input.releaseActions', { context: this.context });
  }

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string, opts: { timeout?: number } = {}): Promise<{ status(): number }> {
    const navigation = this.bidi.send<{ url: string }>('browsingContext.navigate', { context: this.context, url, wait: 'interactive' });
    const timeout = opts.timeout ?? 30000;
    const { url: landed } = await Promise.race([navigation, new Promise<never>((_, reject) =>
      setTimeout(() => reject(new TirnoError(`Navigation has not finished after ${timeout}ms`, 'timeout')), timeout).unref())]);
    this.currentUrl = landed;
    const status = await this.evaluate('performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0') as number;
    return { status: () => status };
  }

  async evaluate(fn: string | ((...args: never[]) => unknown), ...args: unknown[]): Promise<unknown> {
    const call = typeof fn === 'string' ? fn : `(${fn.toString()})(...${JSON.stringify(args)})`;
    const r = await this.bidi.send<EvalResult>('script.evaluate', {
      expression: `(async () => JSON.stringify(await (${call})))()`,
      target: { context: this.context },
      awaitPromise: true,
    });
    if (r.type === 'exception') throw new TirnoError(r.exceptionDetails?.text ?? r.exceptionDetails?.exception?.value?.message ?? 'Expression threw', 'page_threw');
    return r.result?.value === undefined ? undefined : JSON.parse(r.result.value);
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer> {
    if (opts.type === 'webp') throw new TirnoError('Firefox sessions take png or jpeg screenshots', 'capability_unsupported');
    const format = opts.type === 'jpeg'
      ? { type: 'image/jpeg', ...(opts.quality === undefined ? {} : { quality: opts.quality / 100 }) }
      : { type: 'image/png' };
    const { data } = await this.bidi.send<{ data: string }>('browsingContext.captureScreenshot', {
      context: this.context, origin: opts.fullPage ? 'document' : 'viewport', format,
    });
    return Buffer.from(data, 'base64');
  }
}

async function connectBidi(meta: store.SessionMetadata): Promise<Bidi> {
  if (!isAlive(meta.pid)) throw new TirnoError(`${meta.engine === 'safari' ? 'safaridriver' : 'Firefox'} of session '${meta.name}' is gone`, 'session_ghost', { session: meta.name });
  return Bidi.open(meta.wsEndpoint).catch(async (e: unknown) => {
    if (meta.engine !== 'firefox') throw e;
    const wsEndpoint = await startHolder(meta.userDataDir, meta.port);
    store.update(meta.name, { wsEndpoint });
    return Bidi.open(wsEndpoint);
  });
}

interface Context { context: string; url: string }

async function topContexts(bidi: Bidi): Promise<Context[]> {
  return (await bidi.send<{ contexts: Context[] }>('browsingContext.getTree', { maxDepth: 0 })).contexts;
}

/** 탭 ID 접두사(4자 이상) 하나에 맞는 탭. 없거나 여럿이면 거절한다 — 닫고 고르는 명령이 쓴다 */
function pickByHandle(contexts: Context[], handle: string): Context {
  const wanted = handle.trim().toLowerCase();
  if (wanted.length < 4) throw new TirnoError(`Tab id '${handle}' is too short — give at least 4 characters from \`tirno pages\``, 'error');
  const hits = contexts.filter(c => tabHandle(c.context).startsWith(wanted));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new TirnoError(`No tab with id '${handle}' (${contexts.length} open) — run \`tirno pages\``, 'error');
  throw new TirnoError(`Tab id '${handle}' matches ${hits.length} tabs — use more characters`, 'error');
}

/** Firefox · Safari 세션의 탭 — `--tab` 이 고른 것, 아니면 `select` 한 것, 아니면 첫 탭 */
export async function openBidiPage(meta: store.SessionMetadata): Promise<{ page: FirefoxPage; browser: { disconnect(): void } }> {
  const bidi = await connectBidi(meta);
  const contexts = await topContexts(bidi);
  if (!contexts.length) throw new TirnoError(`Session '${meta.name}' has no open tab`, 'firefox_error');
  const wanted = requestedTab();
  const top = wanted ? pickByHandle(contexts, wanted) : contexts.find(c => c.context === meta.selectedTarget) ?? contexts[0];
  store.update(meta.name, { lastAccessedAt: new Date().toISOString() });
  const webdriver = meta.engine === 'safari' && meta.webdriverSessionId
    ? { port: meta.port, session: meta.webdriverSessionId, lock: path.join(meta.userDataDir, 'classic.lock') } : undefined;
  return { page: new FirefoxPage(bidi, top.context, top.url, webdriver), browser: { disconnect: () => bidi.close() } };
}

async function withBidi<T>(meta: store.SessionMetadata, fn: (bidi: Bidi) => Promise<T>): Promise<T> {
  const bidi = await connectBidi(meta);
  try { return await fn(bidi); } finally { bidi.close(); }
}

export async function bidiTabs(meta: store.SessionMetadata): Promise<Array<{ id: string; context: string; url: string; title: string }>> {
  return withBidi(meta, async bidi => Promise.all((await topContexts(bidi)).map(async c => {
    // 제목은 페이지가 답해야 나온다 — 응답 없는 탭 하나가 목록을 붙잡지 않게 2초까지만
    const title = await Promise.race([
      bidi.send<{ result?: { value?: string } }>('script.evaluate', { expression: 'document.title', target: { context: c.context }, awaitPromise: false })
        .then(r => r.result?.value ?? '', () => ''),
      new Promise<string>(r => setTimeout(() => r(''), 2000).unref()),
    ]);
    return { id: tabHandle(c.context), context: c.context, url: c.url, title };
  })));
}

/** 기본은 새 창 — 같은 창의 뒤쪽 탭은 visibilityState 가 hidden 이라 관측이 흔들린다 */
export async function bidiNewTab(meta: store.SessionMetadata, url: string | undefined, type: 'window' | 'tab'): Promise<{ id: string; context: string }> {
  return withBidi(meta, async bidi => {
    const { context } = await bidi.send<{ context: string }>('browsingContext.create', { type });
    if (url) await bidi.send('browsingContext.navigate', { context, url, wait: 'interactive' });
    return { id: tabHandle(context), context };
  });
}

export async function bidiTabByHandle(meta: store.SessionMetadata, handle: string): Promise<Context> {
  return withBidi(meta, async bidi => pickByHandle(await topContexts(bidi), handle));
}

export async function bidiCloseTab(meta: store.SessionMetadata, context: string): Promise<void> {
  await withBidi(meta, bidi => bidi.send('browsingContext.close', { context }));
}

export async function bidiActivate(meta: store.SessionMetadata, context: string): Promise<void> {
  await withBidi(meta, bidi => bidi.send('browsingContext.activate', { context }).catch(() => {}));
}
