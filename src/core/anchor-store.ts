import fs from 'node:fs';
import path from 'node:path';
import * as store from './session-store.js';
import { assertSafeSegment } from './path-guard.js';
import { TirnoError } from '../util/errors.js';

/**
 * An anchor is a stable name a browser MCP can be configured against once:
 *
 *   npx chrome-devtools-mcp --auto-connect --user-data-dir=~/.tirno/anchors/main
 *   ~/.tirno/anchors/main  ──symlink──▶  ../profiles/<session>
 *
 * chrome-devtools-mcp re-reads `<dir>/DevToolsActivePort` on every reconnect,
 * so pointing it at a directory instead of a port number means a chrome restart
 * (new port) is followed automatically, and several anchors can coexist without
 * the port contention that a fixed `--browser-url` creates. Both measured, see
 * docs/plan-anchor-broker.md §7.
 *
 * Anchors are separate from `active` on purpose — see session-store.
 */

export class AnchorNotFound extends TirnoError {
  constructor(anchor: string) {
    super(`Anchor '${anchor}' not found`);
    this.name = 'AnchorNotFound';
  }
}

export class AnchorNotASymlink extends TirnoError {
  constructor(anchor: string, p: string) {
    super(`Refusing to touch anchor '${anchor}': ${p} is not a symlink. tirno only manages symlinked anchors — move it aside if this is real data.`);
    this.name = 'AnchorNotASymlink';
  }
}

export interface Anchor {
  name: string;
  /** the symlink's literal value, e.g. '../profiles/main' */
  target: string;
  /**
   * Absolute path the link points at, resolved lexically against the anchor
   * directory — not realpath'd, so it stays the path the user recognises
   * (`/var/...` rather than macOS's `/private/var/...`). Comparisons that need
   * true identity go through sessionForDir, which does realpath both sides.
   */
  resolved: string;
  /** session whose userDataDir is this directory, if any */
  session: string | null;
  /** target directory exists */
  live: boolean;
}

function readLink(anchor: string): string | null {
  try {
    return fs.readlinkSync(store.anchorPath(anchor));
  } catch {
    return null;
  }
}

/** Session whose profile is this directory. Compared after resolving symlinks. */
export function sessionForDir(resolved: string): string | null {
  const norm = (p: string): string => {
    try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); }
  };
  const target = norm(resolved);
  return store.list().find(s => norm(s.userDataDir) === target)?.name ?? null;
}

export function read(anchor: string): Anchor | null {
  const target = readLink(anchor);
  if (target === null) return null;

  const linkPath = store.anchorPath(anchor);
  const resolved = path.resolve(path.dirname(linkPath), target);
  return {
    name: anchor,
    target,
    resolved,
    session: sessionForDir(resolved),
    live: fs.existsSync(resolved),
  };
}

export function list(): Anchor[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(store.anchorsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isSymbolicLink())
    .map(e => read(e.name))
    .filter((a): a is Anchor => a !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Point an anchor at a session's profile. Returns the anchor it replaced, so
 * the caller can decide whether to evict the browser that was there.
 *
 * Only ever replaces a symlink: if the path exists as a real directory it is
 * someone's profile data, and silently unlinking it would destroy a logged-in
 * session.
 */
export function set(anchor: string, sessionName: string): { previous: Anchor | null } {
  assertSafeSegment(anchor, 'anchor name');
  const meta = store.get(sessionName);          // throws SessionNotFound

  const linkPath = store.anchorPath(anchor);
  fs.mkdirSync(store.anchorsRoot(), { recursive: true });

  const previous = read(anchor);
  let existing: fs.Stats | null = null;
  try { existing = fs.lstatSync(linkPath); } catch { /* absent */ }
  if (existing && !existing.isSymbolicLink()) throw new AnchorNotASymlink(anchor, linkPath);

  // Relative for profiles under ~/.tirno so the tree stays movable; ephemeral
  // sessions live in tmpdir and need the absolute path.
  const target = meta.userDataDir === store.profileDir(sessionName)
    ? path.join('..', 'profiles', sessionName)
    : meta.userDataDir;

  if (existing) fs.unlinkSync(linkPath);
  fs.symlinkSync(target, linkPath);

  return { previous };
}

/** Remove the symlink. The profile it pointed at is never touched. */
export function remove(anchor: string): void {
  assertSafeSegment(anchor, 'anchor name');
  const linkPath = store.anchorPath(anchor);

  let st: fs.Stats;
  try {
    st = fs.lstatSync(linkPath);
  } catch {
    throw new AnchorNotFound(anchor);
  }
  if (!st.isSymbolicLink()) throw new AnchorNotASymlink(anchor, linkPath);

  fs.unlinkSync(linkPath);
}

/** Anchors currently pointing at this session's profile — gc must not delete these. */
export function anchorsForSession(sessionName: string): Anchor[] {
  return list().filter(a => a.session === sessionName);
}
