// File backend — wraps the existing JSON-on-disk visual-cache + trail-store.
//
// query/search is linear (load all + filter in memory). Fine for small/medium
// scale. For larger workloads switch to lance backend.

import * as visualCache from '../core/visual-cache.js';
import * as trailStore from '../core/trail-store.js';
import type {
  WaypointStore,
  WaypointRecord,
  WaypointFilter,
  TrailStore,
  TrailFilter,
} from './types.js';
import type { Trail } from '../core/trail-store.js';
import type { Waypoint } from '../core/visual-cache.js';

function buildSearchText(wp: Waypoint): string {
  const parts: string[] = [];
  const a = wp.channels.a11y;
  const d = wp.channels.dom;
  const v = wp.channels.visual;
  if (a?.role) parts.push(a.role);
  if (a?.name) parts.push(a.name);
  if (a?.description) parts.push(a.description);
  if (d?.selector) parts.push(d.selector);
  if (v?.ocrText) parts.push(v.ocrText);
  return parts.join(' ').toLowerCase();
}

// Load all current entries by iterating the visual-cache list().
async function loadAllRecords(): Promise<WaypointRecord[]> {
  const entries = visualCache.list();
  const out: WaypointRecord[] = [];
  for (const e of entries) {
    for (const wp of e.refs) {
      out.push({
        ...wp,
        url: e.url,
        urlPath: e.urlPath,
        domain: e.domain,
        viewport: e.viewport,
        capturedAt: e.capturedAt,
        searchText: buildSearchText(wp),
      });
    }
  }
  return out;
}

export class FileWaypointStore implements WaypointStore {
  readonly name = 'file';

  async save(rec: WaypointRecord): Promise<void> {
    // Find existing cache entry for this URL+viewport, or create
    const existing = visualCache.lookup(rec.url, { viewport: rec.viewport, mode: 'exact' });
    if (existing) {
      // upsert by id
      const idx = existing.refs.findIndex(r => r.id === rec.id);
      // strip storage-only fields from waypoint
      const wp: Waypoint = { id: rec.id, refId: rec.refId, channels: rec.channels, matchStats: rec.matchStats };
      if (idx >= 0) existing.refs[idx] = wp;
      else existing.refs.push(wp);
      visualCache.save(existing);
    } else {
      visualCache.save({
        schemaVersion: visualCache.ENTRY_SCHEMA_VERSION,
        url: rec.url,
        urlPath: rec.urlPath,
        domain: rec.domain,
        capturedAt: rec.capturedAt,
        visualFp: '',
        viewport: rec.viewport,
        refs: [{ id: rec.id, refId: rec.refId, channels: rec.channels, matchStats: rec.matchStats }],
      });
    }
  }

  async saveAll(recs: WaypointRecord[]): Promise<void> {
    for (const r of recs) await this.save(r);
  }

  async get(id: string): Promise<WaypointRecord | null> {
    const all = await loadAllRecords();
    return all.find(r => r.id === id) ?? null;
  }

  async query(filter: WaypointFilter = {}): Promise<WaypointRecord[]> {
    let recs = await loadAllRecords();
    if (filter.domain) recs = recs.filter(r => r.domain === filter.domain);
    if (filter.url) recs = recs.filter(r => r.url === filter.url);
    if (filter.urlPath) recs = recs.filter(r => r.urlPath === filter.urlPath);
    if (filter.viewport) {
      recs = recs.filter(r =>
        r.viewport.w === filter.viewport!.w &&
        r.viewport.h === filter.viewport!.h &&
        r.viewport.dpr === filter.viewport!.dpr
      );
    }
    if (filter.role) recs = recs.filter(r => r.channels.a11y?.role === filter.role);
    if (filter.search) {
      const q = filter.search.toLowerCase();
      recs = recs.filter(r => (r.searchText ?? '').includes(q));
    }
    if (filter.limit !== undefined) recs = recs.slice(0, filter.limit);
    return recs;
  }

  async delete(id: string): Promise<void> {
    const entries = visualCache.list();
    for (const e of entries) {
      const idx = e.refs.findIndex(r => r.id === id);
      if (idx >= 0) {
        e.refs.splice(idx, 1);
        visualCache.save(e);
        return;
      }
    }
  }
}

export class FileTrailStore implements TrailStore {
  readonly name = 'file';

  async save(trail: Trail): Promise<void> {
    trailStore.save(trail);
  }

  async get(name: string): Promise<Trail | null> {
    try { return trailStore.load(name); } catch { return null; }
  }

  async query(filter: TrailFilter = {}): Promise<Trail[]> {
    let all = trailStore.list();
    if (filter.goal) {
      const q = filter.goal.toLowerCase();
      all = all.filter(t => t.goal.toLowerCase().includes(q));
    }
    if (filter.domain) {
      all = all.filter(t => {
        try { return new URL(t.startUrl).hostname === filter.domain; } catch { return false; }
      });
    }
    if (filter.minSuccessRate !== undefined) {
      all = all.filter(t => {
        const m = t.matchStats;
        if (!m || m.runCount === 0) return false;
        return m.successCount / m.runCount >= filter.minSuccessRate!;
      });
    }
    if (filter.limit !== undefined) all = all.slice(0, filter.limit);
    return all;
  }

  async delete(name: string): Promise<void> {
    trailStore.remove(name);
  }
}
