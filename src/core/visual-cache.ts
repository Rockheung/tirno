import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

function cacheDir(): string {
  return process.env.TIRNO_CACHE_DIR ?? path.join(os.homedir(), '.tirno', 'visual-cache');
}

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Multi-channel waypoint — one element identified across as many channels
// as we could capture. Lookup tries channels in order of past success.
export interface Waypoint {
  id: string;                          // stable id within entry — usually refId
  refId?: string;                      // a11y ref like "@7"

  channels: {
    a11y?: {
      role: string;
      name: string;
      backendId?: number;
      description?: string;
    };
    dom?: {
      selector: string;                // best-effort stable selector
      tagName?: string;
      xpath?: string;                  // future
    };
    visual?: {
      bbox: Bbox;                      // capture-time viewport coords
      visualFp?: string;               // e.g. dHash of element region
      ocrText?: string;                // OCR text within / near bbox
      ocrConf?: number;                // 0-100
    };
  };

  // Match history — populated by replay / lookup attempts. Helps reorder
  // channel try-order on next attempt.
  matchStats?: {
    successCount: number;
    failureCount: number;
    successByChannel: Partial<Record<'dom' | 'a11y' | 'visual.bbox' | 'visual.ocr', number>>;
    lastSuccessAt?: string;
  };
}

/** @deprecated Use Waypoint instead. Old name kept for callers being migrated. */
export type CacheRef = Waypoint;

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
}

export const ENTRY_SCHEMA_VERSION = 2;

export interface CacheEntry {
  schemaVersion: number;
  url: string;
  urlPath: string;
  domain: string;
  capturedAt: string;
  visualFp: string;
  viewport: Viewport;
  refs: Waypoint[];
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

// Migrate any older entry shape into the current schema.
// v1: refs were { refId, role, name, selector?, bbox?, backendId?, source?, confidence? }
// v2: refs are Waypoint with channels{}.
interface LegacyRefV1 {
  refId: string;
  role?: string;
  name?: string;
  selector?: string;
  bbox?: Bbox;
  backendId?: number;
}
interface LegacyEntryV1 {
  url: string; urlPath: string; domain: string; capturedAt: string;
  visualFp: string; viewport: Viewport; refs: LegacyRefV1[];
}
export function migrateEntry(raw: unknown): CacheEntry {
  const e = raw as Partial<CacheEntry> & Partial<LegacyEntryV1>;
  if (e.schemaVersion === ENTRY_SCHEMA_VERSION) return e as CacheEntry;
  // v1 → v2
  const refs = (e.refs ?? []) as Array<LegacyRefV1 | Waypoint>;
  const upgraded: Waypoint[] = refs.map((r) => {
    if ((r as Waypoint).channels) return r as Waypoint;
    const old = r as LegacyRefV1;
    const channels: Waypoint['channels'] = {};
    if (old.role || old.name) {
      channels.a11y = { role: old.role ?? '', name: old.name ?? '', backendId: old.backendId };
    }
    if (old.selector) channels.dom = { selector: old.selector };
    if (old.bbox) channels.visual = { bbox: old.bbox };
    return { id: old.refId, refId: old.refId, channels };
  });
  return {
    schemaVersion: ENTRY_SCHEMA_VERSION,
    url: e.url!,
    urlPath: e.urlPath!,
    domain: e.domain!,
    capturedAt: e.capturedAt!,
    visualFp: e.visualFp!,
    viewport: e.viewport!,
    refs: upgraded,
  };
}

export function save(entry: CacheEntry): string {
  const toSave: CacheEntry = { ...entry, schemaVersion: ENTRY_SCHEMA_VERSION };
  const file = entryFile(entry.domain, entry.urlPath, entry.viewport);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(toSave, null, 2));
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

  let chosen: string;
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

  const raw: unknown = JSON.parse(fs.readFileSync(chosen, 'utf-8'));
  const entry = migrateEntry(raw);
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
          const raw: unknown = JSON.parse(fs.readFileSync(path.join(urlD, f), 'utf-8'));
          out.push(migrateEntry(raw));
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
