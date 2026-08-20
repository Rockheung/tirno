import fs from 'node:fs';
import path from 'node:path';

/**
 * Owns the `DevToolsActivePort` contract — the file Chrome writes into its
 * user-data-dir when launched with `--remote-debugging-port=0`.
 *
 * Two things depend on this file, so the parse must not drift:
 * - tirno, to learn the port the OS actually handed Chrome
 * - chrome-devtools-mcp, when pointed at a directory anchor (`--auto-connect
 *   --user-data-dir=<dir>`); it re-reads the file on every reconnect, which is
 *   what lets a browser MCP follow a Chrome restart onto a new port.
 *
 * Measured 2026-08-14 (Chrome 151), see docs/plan-anchor-broker.md §7:
 * - the file exists ONLY for `--remote-debugging-port=0`; a fixed port writes nothing
 * - Chrome never removes it — not on SIGTERM, SIGKILL, or a graceful CDP
 *   `Browser.close`. Whoever kills Chrome has to clear it (see clearActivePort)
 * - a stale file cannot cause mis-attachment: the browser UUID in the ws path
 *   identifies the instance, so a different browser reusing the port answers 404
 *
 * This is an observed behaviour, not a documented contract — a Chrome update can
 * change it, hence test/devtools-port.test.ts.
 */

export interface ActivePort {
  port: number;
  /** ws path including the browser UUID, e.g. `/devtools/browser/<uuid>` */
  wsPath: string;
  /** the endpoint MCP/puppeteer connects to */
  wsEndpoint: string;
}

export function activePortPath(userDataDir: string): string {
  return path.join(userDataDir, 'DevToolsActivePort');
}

/** Parse the two-line file body. Mirrors chrome-devtools-mcp's own parser. */
export function parseActivePort(content: string): ActivePort | null {
  const [rawPort, rawPath] = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => !!line);

  if (!rawPort || !rawPath) return null;
  const port = Number.parseInt(rawPort, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) return null;
  if (!rawPath.startsWith('/')) return null;

  return { port, wsPath: rawPath, wsEndpoint: `ws://127.0.0.1:${port}${rawPath}` };
}

/** null when the file is absent or malformed — callers fall back, never throw. */
export function readActivePort(userDataDir: string): ActivePort | null {
  try {
    return parseActivePort(fs.readFileSync(activePortPath(userDataDir), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Chrome creates the file while starting its devtools http server, so it is
 * normally there by the time puppeteer resolves. Poll anyway: the write is not
 * ordered against anything we control.
 */
export async function waitForActivePort(
  userDataDir: string,
  timeoutMs = 10000,
): Promise<ActivePort | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = readActivePort(userDataDir);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * Remove the file after killing Chrome. Chrome leaves it behind on every exit
 * path, and a leftover turns the next MCP attempt into an opaque
 * `ECONNREFUSED <port>` instead of a clear "no browser here".
 */
export function clearActivePort(userDataDir: string): void {
  try {
    fs.unlinkSync(activePortPath(userDataDir));
  } catch {
    // absent already, or the profile dir is gone — both fine
  }
}
