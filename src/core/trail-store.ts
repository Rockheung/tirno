// Trail = 사용자가 시연한 행동 시퀀스 (goal + steps).
// step은 RecordedEvent를 그대로 담되, optional waypointId로 cache의
// Waypoint와 연결할 수 있다. matchStats는 replay 누적.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RecordedEvent } from './record-store.js';

function trailsDir(): string {
  const dir = process.env.TIRNO_TRAILS_DIR ?? path.join(os.homedir(), '.tirno', 'trails');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function activeTrailFile(): string {
  return path.join(os.homedir(), '.tirno', 'active-trail.json');
}

export interface TrailStep {
  /** Optional waypoint id from visual-cache (linked when recorded against a snapshotted page). */
  waypointId?: string;
  /** Original captured event — preserves multi-channel context. */
  event: RecordedEvent;
}

export interface TrailMatchStats {
  runCount: number;
  successCount: number;
  lastRunAt?: string;
  /** Per-step channel breakdown over runs (e.g. {"dom":12,"a11y":3,"visual.bbox":1}) */
  successByChannel?: Record<string, number>;
}

export interface Trail {
  name: string;
  goal: string;
  startUrl: string;
  capturedAt: string;
  durationMs: number;
  steps: TrailStep[];
  matchStats?: TrailMatchStats;
}

export interface ActiveTrailMarker {
  goal: string;
  name: string;
  startUrl: string;
  startedAt: string;
}

function trailFile(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Trail name must match [A-Za-z0-9_-]+, got "${name}"`);
  }
  return path.join(trailsDir(), `${name}.json`);
}

export function save(trail: Trail): string {
  const f = trailFile(trail.name);
  fs.writeFileSync(f, JSON.stringify(trail, null, 2));
  return f;
}

export function load(name: string): Trail {
  const f = trailFile(name);
  if (!fs.existsSync(f)) throw new Error(`No trail named "${name}"`);
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

export function list(): Trail[] {
  const dir = trailsDir();
  if (!fs.existsSync(dir)) return [];
  const out: Trail[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return out;
}

export function remove(name: string): void {
  const f = trailFile(name);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function setActive(marker: ActiveTrailMarker): void {
  const f = activeTrailFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(marker, null, 2));
}

export function getActive(): ActiveTrailMarker | null {
  const f = activeTrailFile();
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch { return null; }
}

export function clearActive(): void {
  const f = activeTrailFile();
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function recordRun(name: string, success: boolean, channelStats?: Record<string, number>): void {
  let trail: Trail;
  try { trail = load(name); } catch { return; }
  const stats = trail.matchStats ?? { runCount: 0, successCount: 0, successByChannel: {} };
  stats.runCount += 1;
  if (success) stats.successCount += 1;
  stats.lastRunAt = new Date().toISOString();
  if (channelStats) {
    stats.successByChannel = stats.successByChannel ?? {};
    for (const [ch, n] of Object.entries(channelStats)) {
      stats.successByChannel[ch] = (stats.successByChannel[ch] ?? 0) + n;
    }
  }
  trail.matchStats = stats;
  save(trail);
}
