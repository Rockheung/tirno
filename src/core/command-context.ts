/**
 * 지금 도는 명령의 문맥 — main.ts 의 훅과 fail() 이 공유한다 (#217).
 *
 * 하는 일 둘: (1) stdout 을 가로채 두었다가 저널의 한 줄 요약과 `TIRNO_JSON=1` 의 성공 봉투를
 * 만든다, (2) 명령이 어떻게 끝났든(postAction 이든 fail() 이든) 저널에 한 줄 적는다.
 * 스트림 명령(watch · mcp · screencast)은 가로채지 않는다 — 그 stdout 은 프로토콜이다.
 */
import * as journal from './journal.js';
import type { Delta } from '../cdp/action-delta.js';

interface Context {
  session: string | null;
  cmd: string;
  argv: string[];
  t0: number;
  captured: string[];
  restore: (() => void) | null;
  jsonEnvelope: boolean;
  closed: boolean;
}

let current: Context | null = null;

const STREAMING = new Set(['watch', 'mcp', 'screencast start', 'screencast stop', 'trace-worker', 'screencast-worker', 'schema']);

export function beginCommand(opts: { session: string | null; cmd: string; argv: string[]; jsonEnvelope: boolean }): void {
  const streaming = STREAMING.has(opts.cmd);
  const ctx: Context = { ...opts, t0: Date.now(), captured: [], restore: null, jsonEnvelope: opts.jsonEnvelope && !streaming, closed: false };
  if (!streaming) {
    const out = process.stdout;
    const original = out.write.bind(out);
    // 가로챈다. 봉투 모드면 삼키고, 아니면 그대로 내보내면서 복사만 한다.
    (out as unknown as { write: typeof out.write }).write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      ctx.captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      if (ctx.jsonEnvelope) {
        const cb = rest.find(r => typeof r === 'function') as (() => void) | undefined;
        cb?.();
        return true;
      }
      return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof out.write;
    ctx.restore = () => { (out as unknown as { write: typeof out.write }).write = original; };
  }
  current = ctx;
}

export function currentContext(): { session: string | null; cmd: string } | null {
  return current ? { session: current.session, cmd: current.cmd } : null;
}

/** 성공 — postAction 훅이 부른다 */
export function endCommandOk(): void {
  const ctx = current;
  if (!ctx || ctx.closed) return;
  ctx.closed = true;
  ctx.restore?.();
  const output = ctx.captured.join('');
  const { text, delta, data } = splitOutput(output);
  if (ctx.jsonEnvelope) {
    process.stdout.write(JSON.stringify({ ok: true, cmd: ctx.cmd, ...(data !== undefined ? { data } : { output: text.trimEnd() }), ...(delta ? { delta } : {}) }) + '\n');
  }
  if (ctx.session) journal.append(ctx.session, { t: new Date(ctx.t0).toISOString(), cmd: ctx.cmd, argv: ctx.argv, ok: true, ms: Date.now() - ctx.t0, summary: journal.summaryOf(text), ...(delta ? { delta: deltaSummary(delta) } : {}) });
}

/** 실패 — fail() 이 부른다. 가로챈 출력(경고 등)을 돌려주어 봉투에 실을 수 있게 한다. */
export function endCommandFailed(code: string, message: string): { output: string } {
  const ctx = current;
  if (!ctx || ctx.closed) return { output: '' };
  ctx.closed = true;
  ctx.restore?.();
  const output = ctx.captured.join('');
  if (ctx.session) journal.append(ctx.session, { t: new Date(ctx.t0).toISOString(), cmd: ctx.cmd, argv: ctx.argv, ok: false, ms: Date.now() - ctx.t0, code, summary: message.split('\n')[0].slice(0, 160) });
  return { output: ctx.jsonEnvelope ? output.trimEnd() : '' };
}

export function inJsonEnvelope(): boolean {
  return !!current?.jsonEnvelope;
}

/** 출력에서 `{"delta":…}` 줄을 떼고, 나머지가 통째로 JSON 이면 data 로 */
function splitOutput(output: string): { text: string; delta: Delta | null; data?: unknown } {
  let delta: Delta | null = null;
  const kept: string[] = [];
  for (const line of output.split('\n')) {
    if (/^\{"delta":/.test(line)) { try { delta = (JSON.parse(line) as { delta: Delta }).delta; continue; } catch { /* 그대로 둔다 */ } }
    kept.push(line);
  }
  const text = kept.join('\n');
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return { text, delta, data: JSON.parse(trimmed) }; } catch { /* JSON 이 아니다 */ }
  }
  return { text, delta };
}

function deltaSummary(d: Delta): NonNullable<journal.JournalEntry['delta']> {
  return { url: d.url, added: d.added.length + d.moreAdded, removed: d.removed.length + d.moreRemoved, focus: d.focus, consoleErrors: d.console.errors };
}
