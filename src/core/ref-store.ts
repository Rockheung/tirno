import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REFS_DIR = path.join(os.homedir(), '.wandr', 'refs');

function ensureDir(): void {
  fs.mkdirSync(REFS_DIR, { recursive: true });
}

function refPath(session: string): string {
  return path.join(REFS_DIR, `${session}.json`);
}

export interface RefMap {
  // ref number -> backendDOMNodeId
  [ref: string]: number;
}

export function save(session: string, refs: RefMap): void {
  ensureDir();
  fs.writeFileSync(refPath(session), JSON.stringify(refs, null, 2));
}

export function load(session: string): RefMap {
  const p = refPath(session);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

export function clear(session: string): void {
  const p = refPath(session);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function resolveRef(session: string, refExpr: string): number {
  // expects @N — returns backendDOMNodeId
  const m = /^@(\d+)$/.exec(refExpr);
  if (!m) throw new Error(`Not a ref: ${refExpr}`);
  const refs = load(session);
  const id = refs[m[1]];
  if (id === undefined) throw new Error(`Unknown ref ${refExpr}. Run "wandr snapshot" first.`);
  return id;
}

export function isRef(s: string): boolean {
  return /^@\d+$/.test(s);
}
