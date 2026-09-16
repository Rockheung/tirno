import chalk from 'chalk';
import { TirnoError } from '../util/errors.js';

export interface FormatOptions {
  json?: boolean;
  ndjson?: boolean;
}


// 색 코드는 폭이 아니다 — 셀에 chalk 가 들어가면(ls 의 뱃지 점) 보이는 길이로 맞춘다
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const visibleLength = (s: string): number => s.replace(ANSI, '').length;
const padVisible = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - visibleLength(s)));

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => visibleLength(r[i] ?? '')))
  );

  const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');
  const headerLine = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('│');
  const dataLines = rows.map(row =>
    row.map((cell, i) => ` ${padVisible(cell ?? '', widths[i])} `).join('│')
  );

  return [
    chalk.bold(headerLine),
    sep,
    ...dataLines,
  ].join('\n');
}

export function info(msg: string): void {
  console.log(chalk.cyan('→'), msg);
}

export function success(msg: string): void {
  console.log(chalk.green('✓'), msg);
}

export function warn(msg: string): void {
  console.log(chalk.yellow('⚠'), msg);
}

export function error(msg: string): void {
  console.error(chalk.red('✗'), msg);
}

let jsonFailures = !!process.env['TIRNO_JSON'];
/** 명령이 자기 `--json` 을 받았으면 실패도 JSON 으로 낸다 */
export function setJsonOutput(on: boolean | undefined): void {
  if (on) jsonFailures = true;
}

/**
 * 실패 하나로 끝낸다 — 산문 위에 `code:` 한 줄 (#185).
 *
 * 산문은 사람용이고 그대로다. 기계가 읽을 것은 마지막 줄의 `code: <snake_case>` 다 —
 * 세션 없음 / 남의 것 / 낡은 ref / 분류 안 됨을 문장 파싱 없이 가른다. `--json`
 * (또는 `TIRNO_JSON=1`) 이면 stdout 에 `{ok:false, code, message, data}` 한 줄.
 * 종료 코드는 언제나 1.
 */
export function fail(e: unknown): never {
  const err = e as Error & { code?: unknown; data?: unknown };
  const code = err instanceof TirnoError ? err.code : 'error';
  const message = err?.message ?? String(e);
  if (jsonFailures) {
    console.log(JSON.stringify({ ok: false, code, message, ...(err instanceof TirnoError && err.data ? { data: err.data } : {}) }));
  } else {
    error(message);
    console.error(chalk.dim(`  code: ${code}`));
  }
  process.exit(1);
}
