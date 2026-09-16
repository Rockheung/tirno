/**
 * 레시피 저장소 — 절차를 기억한다 (#211).
 *
 * `~/.tirno/recipes/<domain>/<name>.json`. JSON 인 이유는 의존 0 이다(YAML 파서를 들이지
 * 않는다). 사람이 읽고 고칠 만큼은 평이하다 — 단계마다 사용자가 친 argv 그대로다.
 *
 * 비밀은 절대 파일에 없다. `recipe begin --var EMAIL` 로 이름을 받아 두면, 기록 중 그
 * 환경변수의 값과 같은 인자는 `$EMAIL` 로 적힌다 — 값은 비교에만 쓰고 쓰지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { underRoot } from './paths.js';

export const RECIPE_SCHEMA_VERSION = 1;

export interface RecipeStep {
  /** 사용자가 친 그대로(세션 옵션은 뺀). `$VAR` 는 실행 때 푼다 */
  argv: string[];
  at: string;
  /** `@N` 을 role+name 으로 바꿔 적었으면 원래 것 */
  from?: string;
}

export interface Recipe {
  schemaVersion: number;
  name: string;
  domain: string;
  startUrl?: string;
  vars: string[];
  steps: RecipeStep[];
  recordedAt: string;
  runs: { ok: number; failed: number; lastRunAt?: string; lastFailedStep?: number };
}

/** 세션 메타에 실리는 진행 중 기록 */
export interface RecipeRecording {
  name: string;
  domain: string;
  startUrl?: string;
  vars: string[];
  steps: RecipeStep[];
  startedAt: string;
}

function root(): string {
  return underRoot('recipes');
}

export function domainOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'local';
    return u.host || 'local';
  } catch {
    return 'local';
  }
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function recipePath(domain: string, name: string): string {
  return path.join(root(), safe(domain), `${safe(name)}.json`);
}

export function save(recipe: Recipe): string {
  const p = recipePath(recipe.domain, recipe.name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(recipe, null, 2) + '\n');
  return p;
}

export function load(domain: string, name: string): Recipe | null {
  try {
    return JSON.parse(fs.readFileSync(recipePath(domain, name), 'utf8')) as Recipe;
  } catch {
    return null;
  }
}

export function remove(domain: string, name: string): boolean {
  try {
    fs.unlinkSync(recipePath(domain, name));
    return true;
  } catch {
    return false;
  }
}

export function list(domain?: string): Recipe[] {
  const out: Recipe[] = [];
  let dirs: string[];
  try {
    dirs = domain ? [safe(domain)] : fs.readdirSync(root());
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files: string[];
    try { files = fs.readdirSync(path.join(root(), d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(root(), d, f), 'utf8')) as Recipe); } catch { /* 깨진 파일은 목록에서 뺀다 */ }
    }
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
}

/**
 * 이름으로 찾는다 — 지금 도메인 먼저, 없으면 전체에서 유일할 때만. 둘 이상이면 도메인을
 * 대라고 던진다(첫 것을 조용히 고르지 않는다).
 */
export function find(name: string, preferDomain?: string): Recipe {
  if (preferDomain) {
    const here = load(preferDomain, name);
    if (here) return here;
  }
  const all = list().filter(r => r.name === name);
  if (all.length === 1) return all[0];
  if (all.length === 0) throw new Error(`no recipe named ${JSON.stringify(name)} — \`tirno recipe ls\``);
  throw new Error(`recipe ${JSON.stringify(name)} exists for ${all.length} domains (${all.map(r => r.domain).join(', ')}) — pass --domain`);
}

/** 기록 중 `--var` 로 받은 환경변수 값과 같은 인자를 `$NAME` 으로 */
export function maskVars(argv: string[], vars: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const byValue = new Map<string, string>();
  for (const v of vars) {
    const val = env[v];
    if (val && val.length >= 2) byValue.set(val, v);
  }
  if (byValue.size === 0) return argv;
  return argv.map(a => byValue.has(a) ? `$${byValue.get(a)}` : a);
}

/**
 * 실행 때 `$NAME` / `${NAME}` 을 푼다 — `KEY=value` 인자 먼저, 그다음 환경변수. 없으면 던진다.
 * 인자 하나가 통째로 `$NAME` 인 경우만 푼다(문장 속 `$` 는 건드리지 않는다).
 */
export function expandVars(argv: string[], values: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string[] {
  return argv.map(a => {
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(a);
    if (!m) return a;
    const v = values[m[1]] ?? env[m[1]];
    if (v === undefined) throw new Error(`recipe needs ${m[1]} — pass ${m[1]}=… or export it`);
    return v;
  });
}

export function parseRunVars(args: string[]): { values: Record<string, string>; rest: string[] } {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (const a of args) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a);
    if (m) values[m[1]] = m[2];
    else rest.push(a);
  }
  return { values, rest };
}
