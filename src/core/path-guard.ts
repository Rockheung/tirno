import path from 'node:path';
import { TirnoError } from '../util/errors.js';

/**
 * Names that reach the filesystem — anchors, profiles — come from CLI
 * arguments, and two of the operations built on them (anchor replace, gc)
 * delete things. A name is only ever a single directory entry, never a path.
 *
 * Rejecting traversal here is cheaper than auditing every join afterwards, and
 * a profile directory is someone's logged-in browser session: `tirno gc ../..`
 * must fail on the name, not on luck.
 */

export class UnsafeName extends TirnoError {
  constructor(what: string, name: string, why: string) {
    super(`Invalid ${what} '${name}': ${why}`);
    this.name = 'UnsafeName';
  }
}

export function isSafeSegment(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  // path.basename strips any directory part; if it changed the string, the
  // input was not a bare segment (covers leading './', trailing '/', etc.)
  if (path.basename(name) !== name) return false;
  if (path.isAbsolute(name)) return false;
  return true;
}

export function assertSafeSegment(name: string, what: string): void {
  if (!name) throw new UnsafeName(what, name, 'empty');
  if (!isSafeSegment(name)) {
    throw new UnsafeName(what, name, 'must be a single name, not a path');
  }
}

/**
 * Second gate for deletions: the resolved target must sit *directly* inside the
 * directory tirno manages. Symlinks are resolved before comparing, so an anchor
 * pointing outside cannot smuggle a path in.
 */
export function isDirectChildOf(parent: string, target: string): boolean {
  const p = path.resolve(parent);
  const t = path.resolve(target);
  return path.dirname(t) === p && t !== p;
}
