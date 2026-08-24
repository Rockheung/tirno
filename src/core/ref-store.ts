import fs from 'node:fs';
import path from 'node:path';
import { underRoot } from './paths.js';

function refsDir(): string {
  return underRoot('refs');
}

function ensureDir(): void {
  fs.mkdirSync(refsDir(), { recursive: true });
}

function refPath(session: string): string {
  return path.join(refsDir(), `${session}.json`);
}

export const STORE_SCHEMA_VERSION = 2;

export interface StoredRef {
  backendId: number;
  /** 스냅샷 시점의 a11y 역할·이름. 나중에 "그때 그것이 맞나" 를 물을 근거다. */
  role: string;
  name: string;
}

export interface RefStore {
  schemaVersion: number;
  /**
   * 스냅샷 세대. 찍을 때마다 1 씩 오른다.
   *
   * `@N` 에 세대가 없어서, 스냅샷을 찍은 뒤 페이지가 바뀌면 옛 ref 가 조용히 다른
   * 요소를 가리켰다 — 실패가 에러가 아니라 **오동작**으로 나왔다 (#138). 이 프로젝트는
   * 같은 규율을 flag 에는 이미 적용하고 있다: `drift` 는 선언과 실제가 다르면 조용히
   * 넘어가지 않고 exit 1 이다. 그 규율이 ref 에만 빠져 있었다.
   */
  generation: number;
  /** 그 세대를 찍은 문서. */
  url: string;
  /**
   * 그 문서의 loaderId. **nav 와 reload 를 잡는 값**이다 — 문서가 다시 로드되면 바뀐다
   * (실측). 같은 문서 안의 DOM 교체는 이것으로 안 잡히므로, 그쪽은 요소의 identity 로 본다.
   */
  loaderId: string;
  capturedAt: string;
  refs: { [ref: string]: StoredRef };
}

/** 예전 형태: `{ "7": 123 }`. 세대도 identity 도 없다. */
type LegacyRefMap = { [ref: string]: number };

export function emptyStore(): RefStore {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    generation: 0,
    url: '',
    loaderId: '',
    capturedAt: new Date(0).toISOString(),
    refs: {},
  };
}

function migrate(raw: unknown): RefStore {
  const store = raw as Partial<RefStore> & LegacyRefMap;
  if (store && typeof store === 'object' && 'refs' in store && typeof store.refs === 'object') {
    return {
      ...emptyStore(),
      ...(store as RefStore),
      schemaVersion: STORE_SCHEMA_VERSION,
    };
  }
  // 옛 파일. 세대는 0 이고 loaderId 가 없다 — 검사할 근거가 없다는 뜻이고, 그것을
  // 없는 대로 둔다. 다음 snapshot 이 제대로 채운다.
  const refs: { [ref: string]: StoredRef } = {};
  for (const [k, v] of Object.entries((raw ?? {}) as LegacyRefMap)) {
    if (typeof v === 'number') refs[k] = { backendId: v, role: '', name: '' };
  }
  return { ...emptyStore(), refs };
}

export function save(session: string, store: RefStore): void {
  ensureDir();
  fs.writeFileSync(refPath(session), JSON.stringify(store, null, 2));
}

export function load(session: string): RefStore {
  const p = refPath(session);
  if (!fs.existsSync(p)) return emptyStore();
  try {
    return migrate(JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch {
    return emptyStore();
  }
}

export function clear(session: string): void {
  const p = refPath(session);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export interface ParsedRef {
  ref: string;
  /** `@v3:7` 처럼 세대를 못 박았으면 그 값. `@7` 이면 undefined — 최신 세대로 본다. */
  generation?: number;
}

/**
 * `@7` 과 `@v3:7`.
 *
 * 세대를 못 박는 형태를 **받되 강요하지 않는다.** 스킬과 문서에 `@7` 이 잔뜩 적혀 있고,
 * 그것들이 갑자기 틀린 문법이 되는 것은 이 이슈가 고치려는 문제와 무관한 손해다.
 * `@7` 도 loaderId 와 identity 검사는 똑같이 받는다 — 세대 표기는 검사를 **더** 하는
 * 수단이지, 검사가 걸리는 유일한 조건이 아니다.
 */
export function parseRef(expr: string): ParsedRef | null {
  const pinned = /^@v(\d+):(\d+)$/.exec(expr);
  if (pinned) return { ref: pinned[2]!, generation: Number(pinned[1]) };
  const plain = /^@(\d+)$/.exec(expr);
  if (plain) return { ref: plain[1]! };
  return null;
}

export function isRef(s: string): boolean {
  return parseRef(s) !== null;
}

/** 못 박은 세대가 저장된 세대와 다르면 그 자리에서 끝낸다 — CDP 를 붙일 필요도 없다. */
export function resolveStored(session: string, expr: string): { stored: StoredRef; store: RefStore; ref: string } {
  const parsed = parseRef(expr);
  if (!parsed) throw new Error(`Not a ref: ${expr}`);
  const store = load(session);
  if (parsed.generation !== undefined && parsed.generation !== store.generation) {
    throw new Error(
      `${expr} is from snapshot generation ${parsed.generation}; this session is on generation ${store.generation}. ` +
      `Run "tirno snapshot" and use the refs it prints.`
    );
  }
  const stored = store.refs[parsed.ref];
  if (stored === undefined) {
    throw new Error(`Unknown ref @${parsed.ref}. Run "tirno snapshot" first.`);
  }
  return { stored, store, ref: parsed.ref };
}

/** 하위호환 — backendId 만 필요한 자리. */
export function resolveRef(session: string, refExpr: string): number {
  return resolveStored(session, refExpr).stored.backendId;
}
