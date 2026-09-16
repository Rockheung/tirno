/**
 * 저널 — 세션의 이야기 (#217).
 *
 * 명령마다 한 줄, `~/.tirno/journal/<session>.jsonl`. 무엇을 쳤고(argv) 어떻게 끝났고(ok · code)
 * 무엇이 변했나(delta 요약). `tirno journal` 이 읽고, `--as-recipe` 가 레시피로 뽑는다.
 * metrics.jsonl(전역, 집계용)과 다르다 — 이것은 세션별이고 사람이 읽는 순서다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { underRoot } from './paths.js';

export interface JournalEntry {
  t: string;
  cmd: string;
  argv: string[];
  ok: boolean;
  ms: number;
  code?: string;
  /** ✓/✗ 줄 — 사람이 읽는 한 줄 */
  summary?: string;
  /** delta 가 있었으면 그 요약 */
  delta?: { url?: { from: string; to: string } | null; added?: number; removed?: number; focus?: { from: string; to: string } | null; consoleErrors?: number };
}

function file(session: string): string {
  return underRoot(path.join('journal', `${session.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`));
}

export function append(session: string, entry: JournalEntry): void {
  if (process.env['TIRNO_JOURNAL'] === '0') return;
  const f = file(session);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(entry) + '\n');
}

export function read(session: string, opts: { sinceMs?: number; last?: number } = {}): JournalEntry[] {
  let lines: string[];
  try { lines = fs.readFileSync(file(session), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  let entries = lines.map(l => { try { return JSON.parse(l) as JournalEntry; } catch { return null; } }).filter((e): e is JournalEntry => !!e);
  if (opts.sinceMs !== undefined) {
    const cutoff = Date.now() - opts.sinceMs;
    entries = entries.filter(e => new Date(e.t).getTime() >= cutoff);
  }
  if (opts.last !== undefined) entries = entries.slice(-opts.last);
  return entries;
}

export function clear(session: string): boolean {
  try { fs.unlinkSync(file(session)); return true; } catch { return false; }
}

/** 명령 출력에서 사람용 한 줄 — ✓/✗ 줄, 없으면 첫 줄 */
export function summaryOf(output: string): string | undefined {
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const lines = output.split('\n').map(l => l.replace(ansi, '').trim()).filter(Boolean);
  const hit = lines.find(l => /^[✓✗]/.test(l)) ?? lines[0];
  return hit ? hit.replace(/^[✓✗]\s*/, '').slice(0, 160) : undefined;
}
