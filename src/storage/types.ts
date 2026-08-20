// Storage abstraction — waypoints/trails behind a common interface.
//
// One backend: `file` — the JSON on disk under ~/.tirno (visual-cache + trails),
// which is also the audit/export surface.

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

export type StorageBackendName = 'file';
