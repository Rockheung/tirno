import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import * as store from './session-store.js';
import { profileDir } from './session-store.js';
import { allocate } from './port-allocator.js';

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

export interface LaunchOptions {
  name: string;
  port?: number;
  chromeFlags?: string[];
  executablePath?: string;
  headless?: boolean;
  /** Override default profile dir. Caller is responsible for cleanup if ephemeral. */
  userDataDir?: string;
}

export async function launch(opts: LaunchOptions): Promise<store.SessionMetadata> {
  const port = await allocate(opts.port);
  const executablePath = opts.executablePath ?? findChrome();
  const userDataDir = opts.userDataDir ?? profileDir(opts.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  // Default viewport 1920x1080 — fixed size is required for tirno's
  // visual cache / journaling to be reproducible. User can override by
  // passing their own `--window-size=...` after `--`; chrome uses the
  // last value on the cmdline.
  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1920,1080',
    '--window-position=0,0',
    ...(opts.chromeFlags ?? []),
  ];

  const browser = await puppeteer.launch({
    executablePath,
    headless: opts.headless ?? false,
    userDataDir,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    pipe: false,
    defaultViewport: null,
  });

  const pid = browser.process()?.pid;
  if (!pid) throw new Error('Failed to get Chrome PID');

  const wsEndpoint = browser.wsEndpoint();

  // disconnect without closing — Chrome stays running
  browser.disconnect();

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
