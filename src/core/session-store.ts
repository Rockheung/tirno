import fs from 'node:fs';
import path from 'node:path';
import { SessionNotFound, SessionAlreadyExists } from '../util/errors.js';
import { tirnoDir } from './paths.js';

export interface EmulationState {
  device?: string;
  viewport?: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  network?: string;
  cpu?: number;
  userAgent?: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  geolocation?: { latitude: number; longitude: number; accuracy: number };
}

/**
 * What every session starts with, and what `tirno emulate --reset` goes back to
 * — not to whatever the browser would do on its own.
 *
 * The fixed 1920x1080 is the point: it makes screenshots reproducible and keeps
 * visual-cache viewport keys comparable between sessions (see CLAUDE.md).
 * Clearing to the raw window size instead leaves 1920x993, which silently stops
 * matching every cache entry another session wrote.
 */
export function defaultEmulation(): EmulationState {
  return { viewport: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false } };
}

export interface SessionMetadata {
  name: string;
  pid: number;
  /** Observed at launch. With `--remote-debugging-port=0` the OS picks it. */
  port: number;
  /**
   * Cache hint, NOT truth. Frozen at launch, so it goes stale the moment Chrome
   * restarts (new port, new browser UUID). `profiles/<name>/DevToolsActivePort`
   * is the live value; connect() reads that first and falls back to this for
   * legacy fixed-port sessions, which write no such file.
   */
  wsEndpoint: string;
  userDataDir: string;
  chromeFlags: string[];
  /**
   * Only set when `--executable-path` was given. Chrome auto-detection covers
   * three fixed paths, so a session on Chromium/Brave/Edge is only reproducible
   * if the choice outlives the launch — `restart` reads it back, otherwise the
   * session silently comes back on a different browser (or not at all).
   */
  executablePath?: string;
  createdAt: string;
  lastAccessedAt: string;
  emulation?: EmulationState;
  /**
   * origin → granted permissions, re-applied on every connect. Chrome ties a
   * CDP grant to the DevTools connection, not the profile, so it does not
   * survive a command ending — see cdp/permissions.
   */
  permissions?: Record<string, string[]>;
  group?: string;
  /**
   * Set by `record start`. The recorder itself lives in the page and its buffer
   * is per-origin localStorage, so it cannot answer "where did this recording
   * begin" once the flow navigates. The CLI keeps that here instead.
   */
  recording?: { startUrl: string; startedAt: string };
}

function sessionsRoot(): string {
  return path.join(tirnoDir(), 'sessions');
}

function activeFile(): string {
  return path.join(tirnoDir(), 'active');
}

function ensureDirs(): void {
  fs.mkdirSync(sessionsRoot(), { recursive: true });
  fs.mkdirSync(profilesRoot(), { recursive: true });
}

function sessionPath(name: string): string {
  return path.join(sessionsRoot(), `${name}.json`);
}

export function profileDir(name: string): string {
  return path.join(profilesRoot(), name);
}

export function profilesRoot(): string {
  return path.join(tirnoDir(), 'profiles');
}

/**
 * Anchors are what a browser MCP points at (`--user-data-dir=<anchor>`), and
 * they are deliberately NOT the same thing as `active`: switching the CLI's
 * session must not silently re-aim someone's MCP at a different browser.
 */
export function anchorsRoot(): string {
  return path.join(tirnoDir(), 'anchors');
}

export function anchorPath(anchor: string): string {
  return path.join(anchorsRoot(), anchor);
}

export function create(meta: SessionMetadata): void {
  ensureDirs();
  const p = sessionPath(meta.name);
  if (fs.existsSync(p)) throw new SessionAlreadyExists(meta.name);
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
}

export function get(name: string): SessionMetadata {
  const p = sessionPath(name);
  if (!fs.existsSync(p)) throw new SessionNotFound(name);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

export function update(name: string, patch: Partial<SessionMetadata>): void {
  const meta = get(name);
  const updated = { ...meta, ...patch };
  fs.writeFileSync(sessionPath(name), JSON.stringify(updated, null, 2));
}

export function remove(name: string): void {
  const p = sessionPath(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function list(): SessionMetadata[] {
  ensureDirs();
  return fs.readdirSync(sessionsRoot())
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(sessionsRoot(), f), 'utf-8')));
}

export function rename(oldName: string, newName: string): void {
  const meta = get(oldName);
  if (fs.existsSync(sessionPath(newName))) throw new SessionAlreadyExists(newName);
  remove(oldName);
  create({ ...meta, name: newName });
  if (getActive() === oldName) setActive(newName);
}

export function getActive(): string | null {
  ensureDirs();
  if (!fs.existsSync(activeFile())) return null;
  return fs.readFileSync(activeFile(), 'utf-8').trim() || null;
}

export function setActive(name: string): void {
  ensureDirs();
  fs.writeFileSync(activeFile(), name);
}

export function clearActive(): void {
  if (fs.existsSync(activeFile())) fs.unlinkSync(activeFile());
}
