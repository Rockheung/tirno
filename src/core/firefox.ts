import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isRunnable } from './chrome-finder.js';
import { isAlive } from './process-guard.js';
import * as store from './session-store.js';
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
const WAIT_MS = 15000;

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
        const body = JSON.stringify([0, 1, 'WebDriver:NewSession', { webSocketUrl: true }]);
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
  const script = process.argv[1] && fs.existsSync(process.argv[1]) ? [process.argv[1]] : [];
  spawn(process.execPath, [...script, '__firefox-holder', String(port), file], { detached: true, stdio: 'ignore' }).unref();
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
  const port = await waitFor('Marionette to listen', () => fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, 'utf-8')) : null);
  const wsEndpoint = await startHolder(userDataDir, port);

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
    const { page, browser } = await openFirefoxPage(meta);
    await page.goto(opts.bootUrl);
    browser.disconnect();
  }
  return meta;
}

class Bidi {
  private id = 0;
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
  exceptionDetails?: { text?: string };
}

export class FirefoxPage {
  constructor(private readonly bidi: Bidi, private readonly context: string, private currentUrl: string) {}

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
    if (r.type === 'exception') throw new TirnoError(r.exceptionDetails?.text ?? 'Expression threw', 'page_threw');
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

export async function openFirefoxPage(meta: store.SessionMetadata): Promise<{ page: FirefoxPage; browser: { disconnect(): void } }> {
  if (!isAlive(meta.pid)) throw new TirnoError(`Firefox of session '${meta.name}' is gone`, 'session_ghost', { session: meta.name });
  const bidi = await Bidi.open(meta.wsEndpoint).catch(async () => {
    const wsEndpoint = await startHolder(meta.userDataDir, meta.port);
    store.update(meta.name, { wsEndpoint });
    return Bidi.open(wsEndpoint);
  });
  const { contexts } = await bidi.send<{ contexts: Array<{ context: string; url: string }> }>('browsingContext.getTree', { maxDepth: 0 });
  const top = contexts[0];
  if (!top) throw new TirnoError(`Session '${meta.name}' has no open tab`, 'firefox_error');
  store.update(meta.name, { lastAccessedAt: new Date().toISOString() });
  return { page: new FirefoxPage(bidi, top.context, top.url), browser: { disconnect: () => bidi.close() } };
}
