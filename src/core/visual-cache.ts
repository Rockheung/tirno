import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

function cacheDir(): string {
  return process.env.TIRNO_CACHE_DIR ?? path.join(os.homedir(), '.tirno', 'visual-cache');
}

export interface CacheRef {
  refId: string;
  role: string;
  name: string;
  selector?: string;
  bbox?: { x: number; y: number; w: number; h: number };
  backendId?: number;
}

export interface CacheEntry {
  url: string;
  urlPath: string;
  domain: string;
  capturedAt: string;
  visualFp: string;
  viewport?: { w: number; h: number; dpr: number };
  refs: CacheRef[];
}

export interface UrlKey {
  fullUrl: string;
  domain: string;
  urlPath: string;
}

export function parseUrl(raw: string): UrlKey {
  const u = new URL(raw);
  return {
    fullUrl: u.toString(),
    domain: u.hostname,
    urlPath: `${u.pathname}${u.search}${u.hash}`,
  };
}

function entryFile(domain: string, urlPath: string): string {
  const hash = crypto.createHash('sha1').update(urlPath).digest('hex').slice(0, 16);
  return path.join(cacheDir(), domain, `${hash}.json`);
}

function ensureDir(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

export function save(entry: CacheEntry): string {
  const file = entryFile(entry.domain, entry.urlPath);
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  return file;
}

export function lookup(url: string, mode: 'exact' | 'urlPath' = 'urlPath'): CacheEntry | null {
  const key = parseUrl(url);
  const file = entryFile(key.domain, key.urlPath);
  if (!fs.existsSync(file)) return null;
  const entry: CacheEntry = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (mode === 'exact' && entry.url !== key.fullUrl) return null;
  return entry;
}

export interface ListOptions {
  domain?: string;
  limit?: number;
}

export function list(opts: ListOptions = {}): CacheEntry[] {
  const base = cacheDir();
  if (!fs.existsSync(base)) return [];
  const domains = opts.domain ? [opts.domain] : fs.readdirSync(base);
  const out: CacheEntry[] = [];
  for (const d of domains) {
    const dir = path.join(base, d);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const e: CacheEntry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        out.push(e);
      } catch { /* skip corrupt */ }
    }
  }
  out.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export interface PruneOptions {
  olderThanDays?: number;
  domain?: string;
}

export function prune(opts: PruneOptions = {}): { removed: number } {
  const base = cacheDir();
  if (!fs.existsSync(base)) return { removed: 0 };
  const cutoff = opts.olderThanDays !== undefined
    ? Date.now() - opts.olderThanDays * 86400000
    : null;
  const domains = opts.domain ? [opts.domain] : fs.readdirSync(base);
  let removed = 0;
  for (const d of domains) {
    const dir = path.join(base, d);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(dir, f);
      if (cutoff !== null) {
        try {
          const e: CacheEntry = JSON.parse(fs.readFileSync(file, 'utf-8'));
          if (new Date(e.capturedAt).getTime() >= cutoff) continue;
        } catch { /* corrupt — remove */ }
      }
      fs.unlinkSync(file);
      removed++;
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  return { removed };
}
