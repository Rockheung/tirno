// Storage backend factory.
//
// One backend: the JSON-on-disk visual-cache + trail-store. A second, vector
// -searching backend existed for RAG retrieval; RAG is gone, and with it the
// only thing that backend did better than files.

import type { WaypointStore, TrailStore, StorageBackendName } from './types.js';

export type { WaypointStore, TrailStore, WaypointRecord, WaypointFilter, TrailFilter, StorageBackendName } from './types.js';

let cachedWaypointStore: WaypointStore | null = null;
let cachedTrailStore: TrailStore | null = null;

export async function getWaypointStore(): Promise<WaypointStore> {
  if (cachedWaypointStore) return cachedWaypointStore;
  const mod = await import('./file-backend.js');
  cachedWaypointStore = new mod.FileWaypointStore();
  return cachedWaypointStore;
}

export async function getTrailStore(): Promise<TrailStore> {
  if (cachedTrailStore) return cachedTrailStore;
  const mod = await import('./file-backend.js');
  cachedTrailStore = new mod.FileTrailStore();
  return cachedTrailStore;
}

export function activeBackend(): StorageBackendName {
  return 'file';
}
