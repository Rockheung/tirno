// LanceDB backend — embedded production-grade columnar store + vector search.
//
// Lazy-loaded to keep `tirno --help` fast and avoid native binary download
// for users not using lance backend.
//
// Database: ~/.tirno/lance/  (configurable via TIRNO_LANCE_DIR)
// Tables:   waypoints, trails

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type {
  WaypointStore,
  WaypointRecord,
  WaypointFilter,
  TrailStore,
  TrailFilter,
} from './types.js';
import type { Trail } from '../core/trail-store.js';

function lanceDir(): string {
  return process.env.TIRNO_LANCE_DIR ?? path.join(os.homedir(), '.tirno', 'lance');
}

const EMBEDDING_DIM = parseInt(process.env.TIRNO_EMBEDDING_DIM ?? '384', 10);

// LanceDB types are loose because the SDK has rich generics that conflict with
// our simpler tsc target.
type Table = any;
type Connection = any;

let cachedConn: Connection | null = null;
async function getConnection(): Promise<Connection> {
  if (cachedConn) return cachedConn;
  fs.mkdirSync(lanceDir(), { recursive: true });
  const lance = await import('@lancedb/lancedb');
  cachedConn = await (lance as any).connect(lanceDir());
  return cachedConn!;
}

async function getOrCreateTable(name: string, schema: () => unknown[]): Promise<Table> {
  const conn = await getConnection();
  const tables: string[] = await conn.tableNames();
  if (tables.includes(name)) return conn.openTable(name);
  return conn.createTable(name, schema(), { mode: 'overwrite' });
}

function flattenWaypoint(rec: WaypointRecord): Record<string, unknown> {
  const a = rec.channels.a11y;
  const d = rec.channels.dom;
  const v = rec.channels.visual;
  return {
    id: rec.id,
    refId: rec.refId ?? '',
    url: rec.url,
    urlPath: rec.urlPath,
    domain: rec.domain,
    viewportW: rec.viewport.w,
    viewportH: rec.viewport.h,
    viewportDpr: rec.viewport.dpr,
    capturedAt: rec.capturedAt,
    role: a?.role ?? '',
    name: a?.name ?? '',
    backendId: a?.backendId ?? 0,
    selector: d?.selector ?? '',
    tagName: d?.tagName ?? '',
    bboxX: v?.bbox?.x ?? 0,
    bboxY: v?.bbox?.y ?? 0,
    bboxW: v?.bbox?.w ?? 0,
    bboxH: v?.bbox?.h ?? 0,
    visualFp: v?.visualFp ?? '',
    ocrText: v?.ocrText ?? '',
    ocrConf: v?.ocrConf ?? 0,
    searchText: rec.searchText ?? '',
    embedding: rec.embedding ?? new Array(EMBEDDING_DIM).fill(0),
    statsJson: JSON.stringify(rec.matchStats ?? {}),
  };
}

function unflattenWaypoint(row: Record<string, unknown>): WaypointRecord {
  const id = row.id as string;
  const refId = (row.refId as string) || undefined;
  const channels: WaypointRecord['channels'] = {};
  if (row.role || row.name || row.backendId) {
    channels.a11y = {
      role: (row.role as string) || '',
      name: (row.name as string) || '',
      backendId: (row.backendId as number) || undefined,
    };
  }
  if (row.selector || row.tagName) {
    channels.dom = {
      selector: (row.selector as string) || '',
      tagName: (row.tagName as string) || undefined,
    };
  }
  const bbox = {
    x: row.bboxX as number, y: row.bboxY as number,
    w: row.bboxW as number, h: row.bboxH as number,
  };
  if (bbox.w > 0 || bbox.h > 0) {
    channels.visual = {
      bbox,
      visualFp: (row.visualFp as string) || undefined,
      ocrText: (row.ocrText as string) || undefined,
      ocrConf: (row.ocrConf as number) || undefined,
    };
  }
  let matchStats;
  try { matchStats = JSON.parse(row.statsJson as string); } catch { matchStats = undefined; }
  return {
    id, refId, channels, matchStats,
    url: row.url as string,
    urlPath: row.urlPath as string,
    domain: row.domain as string,
    viewport: { w: row.viewportW as number, h: row.viewportH as number, dpr: row.viewportDpr as number },
    capturedAt: row.capturedAt as string,
    searchText: (row.searchText as string) || undefined,
    embedding: row.embedding as number[] | undefined,
  };
}

export class LanceWaypointStore implements WaypointStore {
  readonly name = 'lance';

  private async table(): Promise<Table> {
    return getOrCreateTable('waypoints', () => [flattenWaypoint({
      id: '__schema__',
      refId: '',
      channels: {},
      url: '', urlPath: '', domain: '',
      viewport: { w: 0, h: 0, dpr: 0 },
      capturedAt: '',
    })]);
  }

  async save(rec: WaypointRecord): Promise<void> {
    const t = await this.table();
    await t.delete(`id = '${rec.id.replace(/'/g, "''")}'`);
    await t.add([flattenWaypoint(rec)]);
  }

  async saveAll(recs: WaypointRecord[]): Promise<void> {
    if (recs.length === 0) return;
    const t = await this.table();
    const ids = recs.map(r => `'${r.id.replace(/'/g, "''")}'`).join(',');
    await t.delete(`id IN (${ids})`);
    await t.add(recs.map(flattenWaypoint));
  }

  async get(id: string): Promise<WaypointRecord | null> {
    const t = await this.table();
    const rows = await t.query().where(`id = '${id.replace(/'/g, "''")}'`).limit(1).toArray();
    return rows.length > 0 ? unflattenWaypoint(rows[0]) : null;
  }

  async query(filter: WaypointFilter = {}): Promise<WaypointRecord[]> {
    const t = await this.table();
    let q = t.query();
    const wheres: string[] = [`id != '__schema__'`];
    if (filter.domain) wheres.push(`domain = '${filter.domain.replace(/'/g, "''")}'`);
    if (filter.url) wheres.push(`url = '${filter.url.replace(/'/g, "''")}'`);
    if (filter.urlPath) wheres.push(`urlPath = '${filter.urlPath.replace(/'/g, "''")}'`);
    if (filter.viewport) {
      wheres.push(`viewportW = ${filter.viewport.w}`);
      wheres.push(`viewportH = ${filter.viewport.h}`);
      wheres.push(`viewportDpr = ${filter.viewport.dpr}`);
    }
    if (filter.role) wheres.push(`role = '${filter.role.replace(/'/g, "''")}'`);
    if (filter.search) wheres.push(`searchText LIKE '%${filter.search.toLowerCase().replace(/'/g, "''")}%'`);
    if (wheres.length > 0) q = q.where(wheres.join(' AND '));
    if (filter.limit !== undefined) q = q.limit(filter.limit);
    const rows = await q.toArray();
    return rows.map(unflattenWaypoint);
  }

  async searchSimilar(embedding: Float32Array, topK: number): Promise<WaypointRecord[]> {
    const t = await this.table();
    const rows = await t.search(Array.from(embedding)).limit(topK).toArray();
    return rows.map(unflattenWaypoint);
  }

  async delete(id: string): Promise<void> {
    const t = await this.table();
    await t.delete(`id = '${id.replace(/'/g, "''")}'`);
  }

  async close(): Promise<void> {
    cachedConn = null;
  }
}

export class LanceTrailStore implements TrailStore {
  readonly name = 'lance';

  private async table(): Promise<Table> {
    return getOrCreateTable('trails', () => [{
      name: '__schema__',
      goal: '',
      startUrl: '',
      capturedAt: '',
      durationMs: 0,
      stepCount: 0,
      runCount: 0,
      successCount: 0,
      lastRunAt: '',
      json: '{}',
    }]);
  }

  async save(trail: Trail): Promise<void> {
    const t = await this.table();
    await t.delete(`name = '${trail.name.replace(/'/g, "''")}'`);
    await t.add([{
      name: trail.name,
      goal: trail.goal,
      startUrl: trail.startUrl,
      capturedAt: trail.capturedAt,
      durationMs: trail.durationMs,
      stepCount: trail.steps.length,
      runCount: trail.matchStats?.runCount ?? 0,
      successCount: trail.matchStats?.successCount ?? 0,
      lastRunAt: trail.matchStats?.lastRunAt ?? '',
      json: JSON.stringify(trail),
    }]);
  }

  async get(name: string): Promise<Trail | null> {
    const t = await this.table();
    const rows = await t.query().where(`name = '${name.replace(/'/g, "''")}'`).limit(1).toArray();
    if (rows.length === 0) return null;
    try { return JSON.parse(rows[0].json as string); } catch { return null; }
  }

  async query(filter: TrailFilter = {}): Promise<Trail[]> {
    const t = await this.table();
    let q = t.query();
    const wheres: string[] = [`name != '__schema__'`];
    if (filter.goal) wheres.push(`goal LIKE '%${filter.goal.toLowerCase().replace(/'/g, "''")}%'`);
    if (wheres.length > 0) q = q.where(wheres.join(' AND '));
    if (filter.limit !== undefined) q = q.limit(filter.limit);
    const rows = await q.toArray();
    let trails = rows.map((r: Record<string, unknown>) => {
      try { return JSON.parse(r.json as string); } catch { return null; }
    }).filter((t: Trail | null): t is Trail => !!t);
    if (filter.domain) {
      trails = trails.filter((t: Trail) => {
        try { return new URL(t.startUrl).hostname === filter.domain; } catch { return false; }
      });
    }
    if (filter.minSuccessRate !== undefined) {
      trails = trails.filter((t: Trail) => {
        const m = t.matchStats;
        if (!m || m.runCount === 0) return false;
        return m.successCount / m.runCount >= filter.minSuccessRate!;
      });
    }
    return trails;
  }

  async delete(name: string): Promise<void> {
    const t = await this.table();
    await t.delete(`name = '${name.replace(/'/g, "''")}'`);
  }

  async close(): Promise<void> {
    cachedConn = null;
  }
}
