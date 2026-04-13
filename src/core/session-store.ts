import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionNotFound, SessionAlreadyExists } from '../util/errors.js';

export interface SessionMetadata {
  name: string;
  pid: number;
  port: number;
  wsEndpoint: string;
  userDataDir: string;
  chromeFlags: string[];
  createdAt: string;
  lastAccessedAt: string;
}

const CHROMUX_DIR = path.join(os.homedir(), '.chromux');
const SESSIONS_DIR = path.join(CHROMUX_DIR, 'sessions');
const PROFILES_DIR = path.join(CHROMUX_DIR, 'profiles');
const ACTIVE_FILE = path.join(CHROMUX_DIR, 'active');

function ensureDirs(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

function sessionPath(name: string): string {
  return path.join(SESSIONS_DIR, `${name}.json`);
}

export function profileDir(name: string): string {
  return path.join(PROFILES_DIR, name);
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
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')));
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
  if (!fs.existsSync(ACTIVE_FILE)) return null;
  return fs.readFileSync(ACTIVE_FILE, 'utf-8').trim() || null;
}

export function setActive(name: string): void {
  ensureDirs();
  fs.writeFileSync(ACTIVE_FILE, name);
}

export function clearActive(): void {
  if (fs.existsSync(ACTIVE_FILE)) fs.unlinkSync(ACTIVE_FILE);
}
