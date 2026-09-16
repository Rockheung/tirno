/**
 * 실패에 종류를 붙인다 (#185).
 *
 * 전부 exit 1 이고 산문뿐이면 호출자는 "재시도해도 되는 실패" 와 "재시도하면 안 되는 실패"
 * 를 문장 파싱으로 갈라야 한다 — 세션 없음(`new` 하면 된다) · foreign(아무것도 하지 마라) ·
 * 낡은 ref(`snapshot` 다시) · 페이지가 던짐(tirno 문제 아님) 이 같은 화면이었다.
 *
 * `code` 는 snake_case 고, 목록은 `tirno schema` 의 `errors` 에 실린다. 종료 코드는 1 로
 * 둔다 — 종료 코드로 종류를 나누면 셸과 broadcast 집계가 복잡해지고, 어차피 JSON 이 더 담는다.
 */

export type ErrorCode =
  | 'error'                 // 분류되지 않은 실패 — 산문만 있다
  | 'session_not_found'
  | 'session_exists'
  | 'session_ghost'         // 대장에만 있고 프로세스가 없다 → restart 또는 gc
  | 'session_not_owned'     // foreign / ambiguous / unknown → 손대지 마라
  | 'no_active_session'
  | 'port_unavailable'
  | 'not_a_ref'
  | 'unknown_ref'           // snapshot 을 안 찍었거나 다른 세션의 번호 → snapshot
  | 'stale_ref'             // 페이지가 바뀌었다 → snapshot 다시 (--stale-ok 로 강행 가능)
  | 'page_threw'            // eval 한 식이 페이지에서 예외를 냈다 — tirno 의 실패가 아니다
  | 'timeout'
  | 'broadcast_partial'     // 일부 세션만 실패 — data.failed 에 이름
  | 'cache_stale'           // 캐시가 지금 화면과 다르다 — snapshot 다시 (--allow-stale 로 강행)
  | 'cache_unresolved'      // 캐시 ref 일부를 지금 페이지에서 못 찾았다 — data.unresolved
  | 'target_not_found'      // role+이름·셀렉터가 아무것도 안 맞는다 → snapshot --interactive
  | 'ambiguous_target'      // role+이름이 여럿에 맞는다 — data.candidates → --exact 또는 @N
  | 'expect_failed'         // expect 의 조건이 틀렸다 — data.expected / data.actual
  | 'a11y_failed';          // a11y --fail-on 의 문턱을 넘는 위반이 있다 — data.counts

/** 코드마다 한 줄 — schema 와 문서가 같은 출처를 읽는다 */
export const ERROR_CODES: Record<ErrorCode, string> = {
  error: 'unclassified failure; the message is all there is',
  session_not_found: 'no session by that name — `tirno new <name>`',
  session_exists: 'a session by that name already exists',
  session_ghost: 'the ledger has the session but the process is gone — `tirno restart` or `tirno gc`',
  session_not_owned: 'the port belongs to something else (foreign/ambiguous) or could not be observed (unknown) — do not touch it',
  no_active_session: 'no -s and no attached session',
  port_unavailable: 'the requested --port is taken',
  not_a_ref: 'the argument is not @N / @vG:N',
  unknown_ref: 'no such ref in this session — `tirno snapshot` first',
  stale_ref: 'the page changed under the snapshot — `tirno snapshot` again (--stale-ok forces)',
  page_threw: 'the evaluated expression threw inside the page — not a tirno failure',
  timeout: 'the operation did not settle in time',
  broadcast_partial: 'some sessions failed — `data.failed` names them',
  cache_stale: 'the cached entry no longer matches the page — `tirno snapshot` again (--allow-stale prints it anyway)',
  cache_unresolved: 'some cached refs were not found on the live page (--require-all) — `data.unresolved` lists them',
  target_not_found: 'nothing on the page matches that role + name (or selector) — `tirno snapshot` lists what is there',
  ambiguous_target: 'the role + name matches several elements — `data.candidates`; be exact (--exact) or use @N',
  expect_failed: 'the expectation did not hold — `data.expected` vs `data.actual`',
  a11y_failed: 'accessibility violations at or above --fail-on — `data.counts`',
};

export class TirnoError extends Error {
  readonly code: ErrorCode;
  /** 기계가 읽을 부가 정보 — JSON 출력의 `data` */
  readonly data?: Record<string, unknown>;

  constructor(message: string, code: ErrorCode = 'error', data?: Record<string, unknown>) {
    super(message);
    this.name = 'TirnoError';
    this.code = code;
    if (data) this.data = data;
  }
}

export class SessionNotFound extends TirnoError {
  constructor(name: string) {
    super(`Session '${name}' not found`, 'session_not_found', { session: name });
    this.name = 'SessionNotFound';
  }
}

export class SessionAlreadyExists extends TirnoError {
  constructor(name: string) {
    super(`Session '${name}' already exists`, 'session_exists', { session: name });
    this.name = 'SessionAlreadyExists';
  }
}

export class ChromeNotRunning extends TirnoError {
  constructor(name: string, pid: number) {
    super(`Chrome for session '${name}' is not running (PID ${pid})`, 'session_ghost', { session: name, pid });
    this.name = 'ChromeNotRunning';
  }
}

/**
 * Something is listening, but observation says it is not this session's chrome.
 * The message names the actual owner — a bare "cannot connect" would invite the
 * user to retry or "clean up" the very process we are protecting.
 */
export class SessionNotOwned extends TirnoError {
  constructor(name: string, port: number | null, reason: string, ownership?: string) {
    super(
      `Refusing to connect to session '${name}'${port === null ? '' : ` (port ${port})`}: ${reason}`,
      'session_not_owned',
      { session: name, port, ...(ownership ? { ownership } : {}) },
    );
    this.name = 'SessionNotOwned';
  }
}

export class NoActiveSession extends TirnoError {
  constructor() {
    super('No active session. Use "tirno attach <name>" or "-s <name>"', 'no_active_session');
    this.name = 'NoActiveSession';
  }
}

export class PortUnavailable extends TirnoError {
  constructor(port: number) {
    super(`Port ${port} is unavailable`, 'port_unavailable', { port });
    this.name = 'PortUnavailable';
  }
}

/** 아무 에러에서 코드를 읽는다 — TirnoError 가 아니면 `error` */
export function codeOf(e: unknown): ErrorCode {
  return e instanceof TirnoError ? e.code : 'error';
}
