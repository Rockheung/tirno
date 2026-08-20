import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function recordingsDir(): string {
  const dir = process.env.TIRNO_RECORDINGS_DIR ?? path.join(os.homedir(), '.tirno', 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface RecordedEvent {
  type: 'click' | 'keydown' | 'input' | 'scroll';
  t: number;                 // ms since start
  x?: number;
  y?: number;
  key?: string;
  value?: string | null;

  // Multi-channel target identification — at least one channel populated for
  // events with a target element. Replay tries channels in order.
  channels?: {
    a11y?: { role?: string; name?: string };
    dom?:  { selector?: string; tagName?: string };
    visual?: { bbox?: { x: number; y: number; w: number; h: number } };
  };

  // Legacy flat fields — kept for back-compat reading old recordings.
  sel?: string | null;
  tag?: string;
  bbox?: { x: number; y: number; w: number; h: number } | null;
}

export interface Recording {
  name: string;
  capturedAt: string;
  durationMs: number;
  startUrl: string;
  events: RecordedEvent[];
}

function filePath(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Recording name must match [A-Za-z0-9_-]+, got "${name}"`);
  }
  return path.join(recordingsDir(), `${name}.json`);
}

export function save(rec: Recording): string {
  const f = filePath(rec.name);
  fs.writeFileSync(f, JSON.stringify(rec, null, 2));
  return f;
}

export function load(name: string): Recording {
  const f = filePath(name);
  if (!fs.existsSync(f)) throw new Error(`No recording named "${name}"`);
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

export function list(): Recording[] {
  const dir = recordingsDir();
  if (!fs.existsSync(dir)) return [];
  const out: Recording[] = [];
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
  const f = filePath(name);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
