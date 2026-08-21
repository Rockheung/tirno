import type { Browser, Permission } from 'puppeteer-core';

/**
 * A CDP permission grant lives on the *connection*, not the profile. Chrome
 * drops it when the DevTools client detaches, and tirno detaches at the end of
 * every command — so a grant made by one command is already gone by the next
 * one, even though the browser and its user-data-dir are untouched.
 *
 * Emulation has the same shape and the same fix: keep the desired state in the
 * session ledger and re-apply it on each connect (see chrome-connector).
 */

/** What Chrome accepts, in puppeteer's spelling. */
export const PERMISSION_NAMES = [
  'accelerometer', 'ambient-light-sensor', 'background-sync', 'camera',
  'clipboard-read', 'clipboard-sanitized-write', 'clipboard-write',
  'geolocation', 'gyroscope', 'idle-detection', 'keyboard-lock',
  'magnetometer', 'microphone', 'midi-sysex', 'midi', 'notifications',
  'payment-handler', 'persistent-storage', 'pointer-lock',
] as const;

/** origin → granted permissions. */
export type PermissionMap = Record<string, string[]>;

/**
 * Chrome keys grants by origin, so a path or query has to go: granting
 * `https://a.com/login` and then reading the clipboard on `https://a.com/home`
 * would silently not match.
 */
export function normalizeOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Not a URL: "${input}" — pass an origin, e.g. https://example.com`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported scheme "${url.protocol}" — only http and https carry permissions`);
  }
  return url.origin;
}

/**
 * Validated up front rather than at the CDP call, because applying is a loop
 * over origins: a name Chrome rejects halfway through would leave some origins
 * granted and the rest not, with the ledger claiming all of them.
 */
export function validatePermissions(names: string[]): Permission[] {
  if (names.length === 0) throw new Error('No permissions given');
  const known = new Set<string>(PERMISSION_NAMES);
  const unknown = names.filter(n => !known.has(n));
  if (unknown.length > 0) {
    throw new Error(`Unknown permission(s): ${unknown.join(', ')}\nKnown: ${PERMISSION_NAMES.join(', ')}`);
  }
  return [...new Set(names)] as Permission[];
}

/**
 * Make the browser match the map exactly. The clear is what makes it exact —
 * without it, revoking one origin would leave the old grant standing until the
 * connection happened to drop.
 */
export async function applyPermissions(browser: Browser, map: PermissionMap): Promise<void> {
  const ctx = browser.defaultBrowserContext();
  await ctx.clearPermissionOverrides();
  for (const [origin, perms] of Object.entries(map)) {
    await ctx.overridePermissions(origin, perms as Permission[]);
  }
}
