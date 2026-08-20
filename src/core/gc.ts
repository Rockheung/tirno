import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as store from './session-store.js';
import * as anchors from './anchor-store.js';
import { collectListeners, inspectSession, type Listener, type SessionInventory } from './inventory.js';
import { readActivePort, activePortPath } from './devtools-port.js';
import { isSafeSegment, isDirectChildOf } from './path-guard.js';

const exec = promisify(execFile);

/**
 * Cleans up what tirno left behind — and nothing else.
 *
 * The split is deliberate: scan() observes, plan() decides (pure, so the rules
 * are testable without deleting anything), apply() acts. Every deletion here is
 * either tirno's own bookkeeping or a directory proven to be an abandoned
 * profile, because a profile directory is a logged-in browser session: removing
 * one is not "cleanup", it is losing the user's cookies.
 *
 * Rules that never bend (docs/plan-anchor-broker.md §3 Stage 4):
 * - `foreign`/`ambiguous` processes and their profiles are never touched
 * - anchor targets, the active session and live sessions are never removed
 * - profile deletion requires --older-than and only ever hits orphans
 */

export interface GcAction {
  kind: 'session-entry' | 'stale-port-file' | 'profile-dir';
  /** what the user sees */
  target: string;
  reason: string;
  /** filesystem path removed, for the deletions that have one */
  path?: string;
  sizeKb?: number;
  lastUsed?: string;
}

export interface GcSkip {
  target: string;
  reason: string;
}

export interface GcPlan {
  actions: GcAction[];
  /** observed and reported, deliberately not acted on */
  skipped: GcSkip[];
}

export interface OrphanProfile {
  name: string;
  dir: string;
  mtime: Date;
  sizeKb?: number;
  /** anchors pointing at this directory — an orphan under an anchor stays */
  anchoredBy: string[];
}

export interface StalePortFile {
  profileDir: string;
  file: string;
  port: number;
}

export interface GcScan {
  sessions: SessionInventory[];
  activeSession: string | null;
  /** session name → anchors aimed at it */
  anchoredSessions: Map<string, string[]>;
  orphans: OrphanProfile[];
  stalePortFiles: StalePortFile[];
}

// ---------------------------------------------------------------- planning

export interface GcOptions {
  /** delete orphan profiles untouched for at least this many days */
  olderThanDays?: number;
}

export function plan(scan: GcScan, opts: GcOptions, now: Date): GcPlan {
  const actions: GcAction[] = [];
  const skipped: GcSkip[] = [];

  for (const s of scan.sessions) {
    if (s.ownership === 'ambiguous') {
      skipped.push({ target: s.name, reason: `ambiguous — ${s.reason}. No automatic action.` });
      continue;
    }
    if (s.ownership === 'ours') continue;        // running and ours — nothing to do

    // Protected even when the entry is stale: an anchor pointing at it is a
    // configured MCP target, and `active` is what bare commands resolve to.
    // Silently dropping either turns a stale label into a confusing one.
    const anchoredBy = scan.anchoredSessions.get(s.name) ?? [];
    if (anchoredBy.length > 0) {
      skipped.push({ target: s.name, reason: `${s.ownership}, but anchored by ${anchoredBy.join(', ')} — entry kept` });
      continue;
    }
    if (scan.activeSession === s.name) {
      skipped.push({ target: s.name, reason: `${s.ownership}, but it is the active session — entry kept` });
      continue;
    }

    switch (s.ownership) {
      case 'ghost':
        actions.push({
          kind: 'session-entry',
          target: s.name,
          reason: `ghost — ${s.reason}`,
        });
        break;
      case 'foreign':
        // Only tirno's own json goes. The process and the profile are someone
        // else's; the entry is simply a wrong label and nothing else can remove
        // it (`tirno kill` refuses foreign, by design).
        actions.push({
          kind: 'session-entry',
          target: s.name,
          reason: `foreign — ${s.reason} (entry only; process and profile untouched)`,
        });
        break;
    }
  }

  for (const f of scan.stalePortFiles) {
    actions.push({
      kind: 'stale-port-file',
      target: path.basename(f.profileDir),
      path: f.file,
      reason: `DevToolsActivePort points at port ${f.port}, nothing listens there`,
    });
  }

  for (const o of scan.orphans) {
    if (o.anchoredBy.length > 0) {
      skipped.push({ target: o.name, reason: `orphan profile, but anchored by ${o.anchoredBy.join(', ')}` });
      continue;
    }
    if (opts.olderThanDays === undefined) {
      skipped.push({ target: o.name, reason: `orphan profile (no session entry). Use --older-than <N>d to remove.` });
      continue;
    }
    const ageDays = (now.getTime() - o.mtime.getTime()) / 86_400_000;
    if (ageDays < opts.olderThanDays) {
      skipped.push({
        target: o.name,
        reason: `orphan profile, last used ${ageDays.toFixed(1)}d ago (< ${opts.olderThanDays}d)`,
      });
      continue;
    }
    actions.push({
      kind: 'profile-dir',
      target: o.name,
      path: o.dir,
      sizeKb: o.sizeKb,
      lastUsed: o.mtime.toISOString().slice(0, 19).replace('T', ' '),
      reason: `orphan profile, unused ${ageDays.toFixed(0)}d`,
    });
  }

  return { actions, skipped };
}

// -------------------------------------------------------------- observing

async function dirSizeKb(dir: string): Promise<number | undefined> {
  try {
    const { stdout } = await exec('du', ['-sk', dir], { timeout: 30000 });
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0], 10);
    return Number.isNaN(kb) ? undefined : kb;
  } catch {
    return undefined;
  }
}

export async function scan(): Promise<GcScan> {
  const sessions = store.list();
  const listeners = await collectListeners();
  const listening = new Set(listeners.map((l: Listener) => l.port));

  const inventories: SessionInventory[] = [];
  for (const meta of sessions) inventories.push(await inspectSession(meta, listeners));

  const anchoredSessions = new Map<string, string[]>();
  const anchoredDirs = new Map<string, string[]>();
  for (const a of anchors.list()) {
    if (a.session) anchoredSessions.set(a.session, [...(anchoredSessions.get(a.session) ?? []), a.name]);
    const key = path.resolve(a.resolved);
    anchoredDirs.set(key, [...(anchoredDirs.get(key) ?? []), a.name]);
  }

  // profile dirs that no session claims
  const claimed = new Set(sessions.map(s => path.resolve(s.userDataDir)));
  const orphans: OrphanProfile[] = [];
  let profileNames: string[] = [];
  try {
    profileNames = fs.readdirSync(store.profilesRoot(), { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.isSymbolicLink())
      .map(e => e.name);
  } catch { /* no profiles dir yet */ }

  for (const name of profileNames) {
    const dir = path.join(store.profilesRoot(), name);
    if (claimed.has(path.resolve(dir))) continue;
    let mtime: Date;
    try { mtime = fs.statSync(dir).mtime; } catch { continue; }
    orphans.push({
      name,
      dir,
      mtime,
      sizeKb: await dirSizeKb(dir),
      anchoredBy: anchoredDirs.get(path.resolve(dir)) ?? [],
    });
  }

  // stale DevToolsActivePort in any profile dir — chrome never removes these
  // itself (measured: SIGTERM, SIGKILL and graceful Browser.close all leave it)
  const stalePortFiles: StalePortFile[] = [];
  for (const name of profileNames) {
    const dir = path.join(store.profilesRoot(), name);
    const active = readActivePort(dir);
    if (active && !listening.has(active.port)) {
      stalePortFiles.push({ profileDir: dir, file: activePortPath(dir), port: active.port });
    }
  }

  return {
    sessions: inventories,
    activeSession: store.getActive(),
    anchoredSessions,
    orphans,
    stalePortFiles,
  };
}

// ----------------------------------------------------------------- acting

export class GcGuardViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GcGuardViolation';
  }
}

/**
 * Re-checks every path immediately before unlinking. plan() already decided,
 * but a deletion guard that only runs at planning time is one refactor away
 * from not running at all.
 */
export function assertDeletable(target: string): void {
  const root = store.profilesRoot();
  const name = path.basename(target);
  if (!isSafeSegment(name)) {
    throw new GcGuardViolation(`refusing to delete '${target}': not a single path segment`);
  }
  if (!isDirectChildOf(root, target)) {
    throw new GcGuardViolation(`refusing to delete '${target}': not directly inside ${root}`);
  }
  if (fs.lstatSync(target).isSymbolicLink()) {
    throw new GcGuardViolation(`refusing to delete '${target}': it is a symlink`);
  }
}

export interface GcResult {
  applied: GcAction[];
  failed: { action: GcAction; error: string }[];
}

export function apply(p: GcPlan, dryRun: boolean): GcResult {
  const applied: GcAction[] = [];
  const failed: { action: GcAction; error: string }[] = [];

  for (const action of p.actions) {
    try {
      if (!dryRun) {
        switch (action.kind) {
          case 'session-entry':
            store.remove(action.target);
            break;
          case 'stale-port-file':
            fs.rmSync(action.path!, { force: true });
            break;
          case 'profile-dir':
            assertDeletable(action.path!);
            fs.rmSync(action.path!, { recursive: true, force: true });
            break;
        }
      }
      applied.push(action);
    } catch (e) {
      failed.push({ action, error: (e as Error).message });
    }
  }

  return { applied, failed };
}
