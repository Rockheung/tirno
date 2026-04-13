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
}

export async function launch(opts: LaunchOptions): Promise<store.SessionMetadata> {
  const port = await allocate(opts.port);
  const executablePath = opts.executablePath ?? findChrome();
  const userDataDir = profileDir(opts.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(opts.chromeFlags ?? []),
  ];

  const browser = await puppeteer.launch({
    executablePath,
    headless: opts.headless ?? false,
    userDataDir,
    args,
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
  };

  store.create(meta);
  store.setActive(opts.name);

  return meta;
}
