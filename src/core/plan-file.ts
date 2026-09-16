/**
 * 계획 파일 — 상태를 파일에 선언한다 (#212).
 *
 * JSON 이다(의존 0). 단계는 argv 배열이거나 한 줄 문자열이다 — 문자열은 셸처럼 따옴표를
 * 존중해 나눈다(`click button "Sign in"` → ["click","button","Sign in"]).
 *
 * ```json
 * { "session": "shop", "vars": ["CARD"], "startUrl": "https://shop/cart",
 *   "steps": [ "ensure url https://shop/cart", ["expect","count","tr.item","ge","1"],
 *              "click button Checkout", "ensure textbox Card = $CARD",
 *              "expect text \"Order confirmed\" within 15s" ] }
 * ```
 */
import fs from 'node:fs';
import type { Recipe } from './recipe-store.js';

export interface PlanFile {
  name: string;
  session?: string;
  group?: string;
  vars: string[];
  startUrl?: string;
  steps: string[][];
}

/** 따옴표를 존중하는 토큰화 — 셸의 단순한 부분집합 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; continue; }
      cur += ch; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    cur += ch;
  }
  if (quote) throw new Error(`unclosed ${quote} in: ${line}`);
  if (cur || has) out.push(cur);
  return out;
}

export function parsePlan(text: string, name: string): PlanFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${name}: not JSON — ${(e as Error).message}`, { cause: e }); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${name}: expected an object with "steps"`);
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.steps) || o.steps.length === 0) throw new Error(`${name}: "steps" must be a non-empty array`);
  const steps = (o.steps as unknown[]).map((s, i) => {
    if (typeof s === 'string') return tokenize(s);
    if (Array.isArray(s) && s.every(x => typeof x === 'string')) return s as string[];
    throw new Error(`${name}: step ${i + 1} must be a string or an array of strings`);
  });
  for (const [i, s] of steps.entries()) if (s.length === 0) throw new Error(`${name}: step ${i + 1} is empty`);
  return {
    name,
    ...(typeof o.session === 'string' ? { session: o.session } : {}),
    ...(typeof o.group === 'string' ? { group: o.group } : {}),
    vars: Array.isArray(o.vars) ? (o.vars as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    ...(typeof o.startUrl === 'string' ? { startUrl: o.startUrl } : {}),
    steps,
  };
}

export function loadPlan(file: string): PlanFile {
  return parsePlan(fs.readFileSync(file, 'utf8'), file);
}

/** 레시피도 계획이다 — 같은 실행기를 탄다 */
export function planFromRecipe(r: Recipe): PlanFile {
  return { name: `${r.domain}/${r.name}`, vars: r.vars, ...(r.startUrl ? { startUrl: r.startUrl } : {}), steps: r.steps.map(s => s.argv) };
}
