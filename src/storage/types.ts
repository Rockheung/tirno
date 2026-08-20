// Storage abstraction — waypoints/trails/match-log behind a common interface.
//
// Backends:
//   - file   : 기존 ~/.tirno/visual-cache + ~/.tirno/trails JSON 파일. backward compat.
//   - lance  : LanceDB embedded vector DB. 큰 규모 + vector 검색.
//
// Selection: env TIRNO_STORAGE_BACKEND ('file' | 'lance'). default 'file'.
//
// raw JSON files는 audit/export 채널로 file backend가 source-of-truth.
// lance backend는 query/검색 인덱스 + (향후) embedding column.

import type { Waypoint, Viewport } from '../core/visual-cache.js';
import type { Trail } from '../core/trail-store.js';

/** Persisted waypoint record (cache entry one row per waypoint). */
export interface WaypointRecord extends Waypoint {
  url: string;
  urlPath: string;
  domain: string;
  viewport: Viewport;
  capturedAt: string;
  /** Concat'd searchable text — name + ocrText + role + selector */
  searchText?: string;
  /** semantic embedding (set by #20 pipeline) */
  embedding?: number[];
}

export interface WaypointFilter {
  url?: string;
  urlPath?: string;
  domain?: string;
  viewport?: Viewport;
  role?: string;
  /** Free-text LIKE on searchText */
  search?: string;
  limit?: number;
}

export interface WaypointStore {
  readonly name: string;
  save(rec: WaypointRecord): Promise<void>;
  saveAll(recs: WaypointRecord[]): Promise<void>;
  get(id: string): Promise<WaypointRecord | null>;
  query(filter?: WaypointFilter): Promise<WaypointRecord[]>;
  searchSimilar?(embedding: Float32Array, topK: number): Promise<WaypointRecord[]>;
  delete(id: string): Promise<void>;
  close?(): Promise<void>;
}

export interface TrailFilter {
  goal?: string;
  domain?: string;
  /** Trails where successCount/runCount >= ratio */
  minSuccessRate?: number;
  limit?: number;
}

export interface TrailStore {
  readonly name: string;
  save(trail: Trail): Promise<void>;
  get(name: string): Promise<Trail | null>;
  query(filter?: TrailFilter): Promise<Trail[]>;
  delete(name: string): Promise<void>;
  close?(): Promise<void>;
}

export type StorageBackendName = 'file' | 'lance';
