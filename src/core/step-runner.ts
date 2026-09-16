/**
 * 단계 실행기 — recipe run 과 apply 가 같이 쓴다 (#211 · #212).
 *
 * 단계 하나는 tirno 자신을 자식으로 친다 — 사용자가 쳤던(또는 파일에 적은) argv 그대로,
 * 세션만 지금 것. 실패하면 그 단계의 문구와 code 를 돌려준다.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface StepResult { ok: boolean; summary: string; code?: string; ms: number }

/** --no-delta 를 아는 명령 — 재생에서는 delta 가 소음이라 끈다 */
const WITH_DELTA = new Set(['click', 'fill', 'type', 'press', 'upload', 'ensure']);

export async function runStep(argv: string[], session: string, opts: { timeoutMs?: number } = {}): Promise<StepResult> {
  const t0 = Date.now();
  const args = [process.argv[1], ...argv, '-s', session, ...(WITH_DELTA.has(argv[0]) ? ['--no-delta'] : [])].filter(Boolean);
  try {
    const { stdout, stderr } = await run(process.execPath, args, {
      env: { ...process.env, TIRNO_JSON: '' }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000,
    });
    return { ok: true, summary: firstLine(stdout + stderr), ms: Date.now() - t0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean };
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const code = /code: ([a-z_]+)/.exec(text)?.[1];
    return { ok: false, summary: err.killed ? 'timed out' : firstLine(text.replace(/\n\s*code: [a-z_]+\s*$/, '')), code, ms: Date.now() - t0 };
  }
}

export function firstLine(s: string): string {
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
  return (lines.find(l => /^[✓✗]/.test(l)) ?? lines[0] ?? '').replace(/^[✓✗]\s*/, '').slice(0, 140);
}

/** 비밀을 출력에서 가린다 — 값이 두 글자 이상일 때만(한 글자는 다 지워 버린다) */
export function masker(secrets: string[]): (s: string) => string {
  const list = secrets.filter(v => v && v.length >= 2);
  return (s) => list.reduce((acc, v) => acc.split(v).join('••••'), s);
}

export interface RunReport {
  ok: boolean;
  /** 실패한 단계 번호(1-based), 성공이면 null */
  failedStep: number | null;
  results: Array<{ index: number; argv: string[]; result: StepResult }>;
}

/**
 * 단계들을 순서대로. 첫 실패에서 멈춘다. `onStep` 이 줄마다 불린다 — 출력은 부르는 쪽 몫이다.
 */
export async function runSteps(
  steps: string[][], session: string,
  opts: { from?: number; onStep?: (index: number, argv: string[], result: StepResult) => void } = {},
): Promise<RunReport> {
  const from = Math.max(1, opts.from ?? 1);
  const results: RunReport['results'] = [];
  for (let i = from - 1; i < steps.length; i++) {
    const result = await runStep(steps[i], session);
    results.push({ index: i + 1, argv: steps[i], result });
    opts.onStep?.(i + 1, steps[i], result);
    if (!result.ok) return { ok: false, failedStep: i + 1, results };
  }
  return { ok: true, failedStep: null, results };
}
