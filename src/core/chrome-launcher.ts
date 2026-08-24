import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './session-store.js';
import { profileDir } from './session-store.js';
import { allocate } from './port-allocator.js';
import { waitForActivePort, clearActivePort } from './devtools-port.js';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
];

function findChrome(): string {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome not found. Install Google Chrome or set --executable-path');
}

function portFromWsEndpoint(wsEndpoint: string): number | null {
  try {
    const port = Number.parseInt(new URL(wsEndpoint).port, 10);
    return Number.isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

export interface LaunchOptions {
  name: string;
  port?: number;
  chromeFlags?: string[];
  executablePath?: string;
  headless?: boolean;
  /** Override default profile dir. Caller is responsible for cleanup if ephemeral. */
  userDataDir?: string;
  /** URL appended as final chrome arg — chrome opens it directly, skipping about:blank. */
  bootUrl?: string;
  /**
   * Let extensions run. Off by default, because an extension can change what
   * the page does and this tool exists to observe pages as they are.
   */
  extensions?: boolean;
}

/**
 * 번역 제안을 끈다. 프로필의 `Default/Preferences` 에 심는다.
 *
 * `--disable-features=Translate` 로는 부족하다 — puppeteer 가 이미 그것을 넣고 있는데도
 * 번역 UI 가 떴고, 프로필에 `translate_ignored_count_for_language` 가 남아 있었다(실측).
 *
 * 번역 버블은 페이지 위에 겹쳐 뜨고 레이아웃을 밀어낸다. 좌표로 클릭하고 스크린샷을
 * 비교하는 도구에서 그것은 관측 대상이 아니라 잡음이다 — 뷰포트를 1920x1080 으로
 * 고정하는 것과 같은 이유로 고정한다.
 *
 * 이미 있는 값은 건드리지 않는다. 사용자가 그 프로필에서 켰다면 그쪽이 나중 의사다.
 */
function seedProfilePrefs(userDataDir: string): void {
  const file = path.join(userDataDir, 'Default', 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    // 아직 없다(첫 기동) 또는 읽을 수 없다 — 어느 쪽이든 새로 쓴다.
  }

  const translate = (prefs.translate ?? {}) as Record<string, unknown>;
  if (translate.enabled !== undefined) return;
  translate.enabled = false;
  prefs.translate = translate;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prefs));
  } catch {
    // 못 써도 기동은 막지 않는다. 번역 버블이 뜰 뿐이다.
  }
}

export async function launch(opts: LaunchOptions): Promise<store.SessionMetadata> {
  // Default to `--remote-debugging-port=0`: the OS picks a free port and chrome
  // records it in DevToolsActivePort. That removes the port-collision class
  // entirely (9222+ is a shared range — other apps squat it) and is what lets a
  // browser MCP anchor on the profile *directory* instead of a port number.
  // An explicit --port keeps the legacy fixed-port path, which writes no
  // DevToolsActivePort and so cannot be an anchor target (`tirno new` warns).
  const requestedPort = opts.port === undefined ? 0 : await allocate(opts.port);
  const executablePath = opts.executablePath ?? findChrome();
  const userDataDir = opts.userDataDir ?? profileDir(opts.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  // A previous chrome on this profile left its DevToolsActivePort behind (chrome
  // never removes it — measured, see devtools-port.ts). Clear it first so the
  // file we read back below can only have been written by the chrome we launch.
  clearActivePort(userDataDir);

  seedProfilePrefs(userDataDir);

  // Default viewport 1920x1080 — fixed size is required for tirno's
  // visual cache / journaling to be reproducible. User can override by
  // passing their own `--window-size=...` after `--`; chrome uses the
  // last value on the cmdline.
  const args = [
    `--remote-debugging-port=${requestedPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1920,1080',
    '--window-position=0,0',
    ...(opts.chromeFlags ?? []),
  ];
  // Chrome treats trailing positional args as start URLs. Putting bootUrl
  // last means chrome opens it on launch — no about:blank flash, no separate
  // navigate round-trip.
  if (opts.bootUrl) args.push(opts.bootUrl);

  // puppeteer assumes the browser dies with the process that launched it, and
  // wires that up three ways: SIGINT/SIGTERM/SIGHUP handlers, and a `process`
  // 'exit' listener that is not behind any option. A tirno session has to
  // outlive the CLI invocation that created it, so all three have to go — the
  // signal handlers by option, the exit listener by hand below.
  const exitListenersBefore = new Set(process.listeners('exit'));

  const browser = await puppeteer.launch({
    executablePath,
    headless: opts.headless ?? false,
    userDataDir,
    args,
    // puppeteer's default args inject their own `--remote-debugging-port`,
    // which silently overrides ours. Drop both so only our
    // `--remote-debugging-port=${requestedPort}` reaches chrome.
    //
    // `--disable-extensions` is also puppeteer's, and it cannot be undone from
    // the far side: passing `--load-extension` after it does not cancel it, and
    // `Extensions.loadUnpacked` still answers with an extension id while
    // activating nothing — no extension target, no content script. A CDP call
    // that reports success and does nothing is worse than one that fails, so
    // the flag has to be dropped at launch or not at all.
    ignoreDefaultArgs: [
      '--enable-automation',
      '--remote-debugging-port',
      ...(opts.extensions ? ['--disable-extensions'] : []),
    ],
    pipe: false,
    defaultViewport: null,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });

  const chromeProcess = browser.process();
  const pid = chromeProcess?.pid;
  if (!pid) throw new Error('Failed to get Chrome PID');

  const wsEndpoint = browser.wsEndpoint();

  // disconnect without closing — Chrome stays running
  browser.disconnect();

  // Whatever puppeteer added is its browser-killing listener; anything that was
  // already there belongs to the caller and stays.
  for (const listener of process.listeners('exit')) {
    if (!exitListenersBefore.has(listener)) process.removeListener('exit', listener);
  }

  // Chrome is a child of this process, and node keeps the event loop alive for
  // a live child handle and its stdio pipes. Without this the command never
  // returns — and killing it to get the shell back takes Chrome with it.
  // The stdio streams are typed as plain Readable/Writable but are net.Socket
  // at runtime (stdio: 'pipe'), so unref is there. Unref rather than destroy —
  // a destroyed read end gives Chrome EPIPE on its next stderr write.
  for (const stream of [chromeProcess.stdin, chromeProcess.stdout, chromeProcess.stderr]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }
  chromeProcess.unref();

  // With port 0 the requested port is not the real one. DevToolsActivePort is
  // what chrome itself wrote, and it is the same file a directory-anchored MCP
  // reads, so prefer it. wsEndpoint (parsed by puppeteer from chrome's stderr)
  // is the fallback — it carries the real port too, just without the file.
  const active = requestedPort === 0 ? await waitForActivePort(userDataDir) : null;
  const port = active?.port ?? portFromWsEndpoint(wsEndpoint) ?? requestedPort;

  const now = new Date().toISOString();
  const meta: store.SessionMetadata = {
    name: opts.name,
    pid,
    port,
    wsEndpoint,
    userDataDir,
    chromeFlags: args,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    createdAt: now,
    lastAccessedAt: now,
    // Pin JS-side viewport to 1920x1080 via setDeviceMetricsOverride. Chrome
    // window-size flag handles the OS window, but the inner viewport differs
    // by chrome bar height; emulation viewport pins it deterministically.
    emulation: store.defaultEmulation(),
  };

  store.create(meta);
  store.setActive(opts.name);

  return meta;
}
