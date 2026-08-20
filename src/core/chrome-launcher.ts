import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
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
    ignoreDefaultArgs: ['--enable-automation', '--remote-debugging-port'],
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
    createdAt: now,
    lastAccessedAt: now,
    // Pin JS-side viewport to 1920x1080 via setDeviceMetricsOverride. Chrome
    // window-size flag handles the OS window, but the inner viewport differs
    // by chrome bar height; emulation viewport pins it deterministically.
    emulation: {
      viewport: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false },
    },
  };

  store.create(meta);
  store.setActive(opts.name);

  return meta;
}
