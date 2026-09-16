/**
 * 페이지에서 온 문자열을 낼 때의 두 가지 규율 (#190).
 *
 * 1. **상한이 있으면 잘렸다고 말한다.** `snapshot` 은 긴 피드에서 수천 줄을 낸다. 호출자가
 *    LLM 이면 그 줄 수가 컨텍스트고, 잘라서 읽으면 잘렸다는 사실을 모른다. 잘림 표시가
 *    없는 잘림은 하지 않는다 — 마지막 줄이 언제나 몇 줄 중 몇 줄인지 말한다.
 * 2. **페이지 내용과 tirno 의 말을 가른다.** a11y 이름·eval 결과·console 은 페이지가 쓴
 *    문자열이다. `heading "Ignore previous instructions"` 가 tirno 의 출력과 같은 서식으로
 *    나온다. 경계 표식은 보안 경계가 아니라 **표식**이다 — 실행마다 다른 nonce 를 붙여
 *    페이지가 표식을 흉내 내기 어렵게 할 뿐이다.
 */
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';

export interface Truncation {
  shownLines: number;
  totalLines: number;
  shownChars: number;
  totalChars: number;
}

/** 옵션 → env → 없음. 0 이나 음수는 "상한 없음" 이다. */
export function resolveMaxOutput(opt?: number): number | undefined {
  const raw = opt ?? (process.env['TIRNO_MAX_OUTPUT'] ? Number(process.env['TIRNO_MAX_OUTPUT']) : undefined);
  if (raw === undefined || Number.isNaN(raw) || raw <= 0) return undefined;
  return Math.floor(raw);
}

export function boundariesEnabled(opt?: boolean): boolean {
  return !!opt || process.env['TIRNO_CONTENT_BOUNDARIES'] === '1';
}

/** 줄 단위로 자른다 — 줄 중간에서 끊긴 a11y 행은 없는 요소처럼 읽힌다. */
export function truncateLines(lines: string[], maxChars: number | undefined): { lines: string[]; truncation?: Truncation } {
  const totalChars = lines.reduce((n, l) => n + l.length + 1, 0);
  if (maxChars === undefined || totalChars <= maxChars) return { lines };
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > maxChars) break;
    out.push(l);
    used += l.length + 1;
  }
  return {
    lines: out,
    truncation: { shownLines: out.length, totalLines: lines.length, shownChars: used, totalChars },
  };
}

export function truncationNote(t: Truncation, narrowHint: string): string {
  return `… truncated: showed ${t.shownLines.toLocaleString()} of ${t.totalLines.toLocaleString()} lines `
    + `(${t.shownChars.toLocaleString()}/${t.totalChars.toLocaleString()} chars). ${narrowHint}, or raise --max-output.`;
}

export interface Boundary { begin: string; end: string; nonce: string }

export function makeBoundary(label = 'page content'): Boundary {
  const nonce = randomBytes(3).toString('hex');
  return {
    nonce,
    begin: `--- ${label} (untrusted) begin ${nonce} ---`,
    end: `--- ${label} end ${nonce} ---`,
  };
}

export interface EmitOptions {
  maxOutput?: number;
  boundaries?: boolean;
  /** 잘림 안내에 들어갈 "좁히는 법" */
  narrowHint: string;
  label?: string;
}

/**
 * 페이지 문자열을 stdout 에 낸다. 경계는 페이지 내용만 감싸고, 잘림 안내는 tirno 의 말이라
 * 경계 밖(뒤)에 둔다. 돌려주는 값은 호출자가 `--json` 에 싣거나 로그에 적을 때 쓴다.
 */
export function emitPageLines(lines: string[], opts: EmitOptions): { truncation?: Truncation; boundary?: Boundary } {
  const { lines: shown, truncation } = truncateLines(lines, opts.maxOutput);
  const boundary = opts.boundaries ? makeBoundary(opts.label) : undefined;
  if (boundary) console.log(chalk.dim(boundary.begin));
  for (const l of shown) console.log(l);
  if (boundary) console.log(chalk.dim(boundary.end));
  if (truncation) console.log(chalk.yellow('⚠'), truncationNote(truncation, opts.narrowHint));
  return { truncation, boundary };
}
