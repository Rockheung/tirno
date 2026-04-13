import puppeteer, { type Browser } from 'puppeteer-core';
import * as store from './session-store.js';
import { isAlive } from './process-guard.js';
import { ChromeNotRunning, NoActiveSession } from '../util/errors.js';

export async function connect(sessionName?: string): Promise<{ browser: Browser; meta: store.SessionMetadata }> {
  const name = sessionName ?? store.getActive();
  if (!name) throw new NoActiveSession();

  const meta = store.get(name);

  if (!isAlive(meta.pid)) {
    throw new ChromeNotRunning(name, meta.pid);
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: meta.wsEndpoint,
  });

  store.update(name, { lastAccessedAt: new Date().toISOString() });

  return { browser, meta };
}
