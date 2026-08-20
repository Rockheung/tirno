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
  source?: 'a11y' | 'vision';  // default 'a11y' for back-compat
  confidence?: number;          // populated for vision-sourced refs
}

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
}

export interface CacheEntry {
  url: string;
  urlPath: string;
  domain: string;
  capturedAt: string;
  visualFp: string;
  viewport: Viewport;            // required — bbox/refs are viewport-bound
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

export function viewportKey(v: Viewport): string {
  return `${v.w}x${v.h}@${v.dpr}`;
}

export function parseViewportKey(s: string): Viewport | null {
  const m = /^(\d+)x(\d+)@([\d.]+)$/.exec(s);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]), dpr: Number(m[3]) };
}

// Path layout — viewport-aware:
//   <cacheDir>/<domain>/<sha1(urlPath)>/<wxh@dpr>.json
// Same URL viewed at different viewports = separate files.
function urlDir(domain: string, urlPath: string): string {
  const hash = crypto.createHash('sha1').update(urlPath).digest('hex').slice(0, 16);
  return path.join(cacheDir(), domain, hash);
}

function entryFile(domain: string, urlPath: string, viewport: Viewport): string {
  return path.join(urlDir(domain, urlPath), `${viewportKey(viewport)}.json`);
}

export function save(entry: CacheEntry): string {
  const file = entryFile(entry.domain, entry.urlPath, entry.viewport);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  return file;
}

export interface LookupOptions {
  viewport?: Viewport;
  mode?: 'exact' | 'urlPath';
}

// Return the entry for given url. If viewport specified, exact viewport file
// must exist. If not, return the most-recently-captured viewport entry.
export function lookup(url: string, opts: LookupOptions = {}): CacheEntry | null {
  const mode = opts.mode ?? 'urlPath';
  const key = parseUrl(url);
  const dir = urlDir(key.domain, key.urlPath);
  if (!fs.existsSync(dir)) return null;

  let chosen: string | null = null;
  if (opts.viewport) {
    const exact = entryFile(key.domain, key.urlPath, opts.viewport);
    if (!fs.existsSync(exact)) return null;
    chosen = exact;
  } else {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return null;
    files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    chosen = path.join(dir, files[0]);
  }

  const entry: CacheEntry = JSON.parse(fs.readFileSync(chosen, 'utf-8'));
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
    const dDir = path.join(base, d);
    if (!fs.existsSync(dDir) || !fs.statSync(dDir).isDirectory()) continue;
    for (const urlHash of fs.readdirSync(dDir)) {
      const urlD = path.join(dDir, urlHash);
      if (!fs.statSync(urlD).isDirectory()) continue;
      for (const f of fs.readdirSync(urlD)) {
        if (!f.endsWith('.json')) continue;
        try {
          const e: CacheEntry = JSON.parse(fs.readFileSync(path.join(urlD, f), 'utf-8'));
          out.push(e);
        } catch { /* skip corrupt */ }
      }
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
    const dDir = path.join(base, d);
    if (!fs.existsSync(dDir) || !fs.statSync(dDir).isDirectory()) continue;
    for (const urlHash of fs.readdirSync(dDir)) {
      const urlD = path.join(dDir, urlHash);
      if (!fs.statSync(urlD).isDirectory()) {
        // legacy flat layout — prune as a single file too
        if (urlHash.endsWith('.json')) {
          if (cutoff !== null) {
            try {
              const e: CacheEntry = JSON.parse(fs.readFileSync(urlD, 'utf-8'));
              if (new Date(e.capturedAt).getTime() >= cutoff) continue;
            } catch { /* corrupt — remove */ }
          }
          fs.unlinkSync(urlD);
          removed++;
        }
        continue;
      }
      for (const f of fs.readdirSync(urlD)) {
        if (!f.endsWith('.json')) continue;
        const file = path.join(urlD, f);
        if (cutoff !== null) {
          try {
            const e: CacheEntry = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (new Date(e.capturedAt).getTime() >= cutoff) continue;
          } catch { /* corrupt — remove */ }
        }
        fs.unlinkSync(file);
        removed++;
      }
      if (fs.readdirSync(urlD).length === 0) fs.rmdirSync(urlD);
    }
    if (fs.readdirSync(dDir).length === 0) fs.rmdirSync(dDir);
  }
  return { removed };
}
