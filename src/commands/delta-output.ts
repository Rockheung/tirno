/**
 * 행동 명령이 성공 줄 뒤에 delta 를 붙이는 한 자리 (#209).
 *
 * `--no-delta` 면 아무것도 안 한다. `TIRNO_JSON=1` 이면 delta 를 JSON 한 줄로(성공 봉투
 * 통일은 #217 — 그 전까지는 이 줄 하나가 기계용이다).
 */
import chalk from 'chalk';
import type { Page } from '../cdp/page.js';
import { withDelta, formatDelta, type Delta } from '../cdp/action-delta.js';

export interface DeltaOpts { delta?: boolean }

/** 옵션이 켜져 있으면 감싸고, 아니면 그냥 돌린다 */
export async function actWithDelta<T>(page: Page, opts: DeltaOpts, action: () => Promise<T>): Promise<{ result: T; delta: Delta | null }> {
  if (opts.delta === false) return { result: await action(), delta: null };
  const { result, delta } = await withDelta(page, action);
  return { result, delta };
}

export function printDelta(delta: Delta | null): void {
  if (!delta) return;
  if (process.env['TIRNO_JSON']) {
    console.log(JSON.stringify({ delta }));
    return;
  }
  for (const line of formatDelta(delta)) console.log(chalk.dim(`  ${line}`));
}

export const DELTA_FLAG = ['--no-delta', 'Do not report what changed after the action (url, added/removed a11y lines, console errors). On by default so a click that did nothing says so'] as const;
