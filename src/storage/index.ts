// Storage backend factory.
//
// Selection:
//   TIRNO_STORAGE_BACKEND=file (default) | lance
//
// File backend wraps the existing visual-cache + trail-store JSON layer
// (backward compat). Lance backend is lazy-loaded only if selected.

import type { WaypointStore, TrailStore, StorageBackendName } from './types.js';

export type { WaypointStore, TrailStore, WaypointRecord, WaypointFilter, TrailFilter, StorageBackendName } from './types.js';

let cachedWaypointStore: WaypointStore | null = null;
let cachedTrailStore: TrailStore | null = null;

function selected(): StorageBackendName {
  const v = process.env.TIRNO_STORAGE_BACKEND;
  if (v === 'lance') return 'lance';
  return 'file';
}

export async function getWaypointStore(): Promise<WaypointStore> {
  if (cachedWaypointStore) return cachedWaypointStore;
  if (selected() === 'lance') {
    const mod = await import('./lance-backend.js');
    cachedWaypointStore = new mod.LanceWaypointStore();
  } else {
    const mod = await import('./file-backend.js');
    cachedWaypointStore = new mod.FileWaypointStore();
  }
  return cachedWaypointStore;
}

export async function getTrailStore(): Promise<TrailStore> {
  if (cachedTrailStore) return cachedTrailStore;
  if (selected() === 'lance') {
    const mod = await import('./lance-backend.js');
    cachedTrailStore = new mod.LanceTrailStore();
  } else {
    const mod = await import('./file-backend.js');
    cachedTrailStore = new mod.FileTrailStore();
  }
  return cachedTrailStore;
}

export function activeBackend(): StorageBackendName {
  return selected();
}
