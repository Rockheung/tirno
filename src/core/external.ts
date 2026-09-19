import type { SessionMetadata } from './session-store.js';

/**
 * 외부 CDP 엔드포인트 — tirno 가 띄우지 않은 브라우저(adb 포워드된 안드로이드 크롬,
 * ssh 터널, 도커 안 크롬). `tirno connect` 가 등록하고 `kind: 'external'` 로 원장에 남는다.
 *
 * 소유권 판정의 "포트를 쥔 pid 의 커맨드라인에 내 --user-data-dir 가 있다" 는 이런
 * 엔드포인트에서 성립할 수 없다 — CDP 를 열어 주는 것이 adb 나 ssh 라 크롬의 커맨드라인이
 * 이 머신에 없다(#236). 대신 `/json/version` 이 답하는가로 살아 있음을 본다. 붙기만 했지
 * 띄운 것이 아니므로 kill · restart 는 프로세스를 건드리지 않는다.
 */

export interface DevToolsVersion {
  /** 도달 가능한 host:port 로 고쳐 쓴 브라우저 ws 엔드포인트 */
  wsEndpoint: string;
  browser: string;
  protocolVersion: string;
}

/**
 * `tirno connect` 의 인자 → `/json/version` 의 HTTP 베이스. `9223` · `127.0.0.1:9223` ·
 * `http://…` · `ws://…/devtools/browser/…` 전부 host:port 만 취한다.
 */
export function httpBaseOf(endpoint: string): URL {
  const raw = /^\d+$/.test(endpoint) ? `http://127.0.0.1:${endpoint}`
    : /^[\w.-]+:\d+$/.test(endpoint) ? `http://${endpoint}`
    : endpoint;
  const u = new URL(raw);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new Error(`Unsupported endpoint scheme '${u.protocol}' — give a port, host:port, http:// or ws:// URL`);
  return new URL(`${u.protocol.startsWith('ws') ? u.protocol.replace('ws', 'http') : u.protocol}//${u.host}`);
}

/**
 * `/json/version` 을 묻는다. 못 닿으면 null — 예외를 던지지 않는 이유는 `ls` 가 세션마다
 * 이걸 부르기 때문이다. 응답의 ws URL 은 host 를 우리가 닿은 쪽으로 고친다: 도커·원격
 * 크롬은 자기 안에서 보이는 주소(`0.0.0.0` · 컨테이너 호스트명)를 적어 준다.
 */
export async function probeDevTools(base: URL, timeoutMs = 1500): Promise<DevToolsVersion | null> {
  try {
    const res = await fetch(new URL('/json/version', base), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const v = await res.json() as { webSocketDebuggerUrl?: string; Browser?: string; 'Protocol-Version'?: string };
    if (!v.webSocketDebuggerUrl) return null;
    const ws = new URL(v.webSocketDebuggerUrl);
    ws.host = base.host;
    return { wsEndpoint: ws.toString(), browser: v.Browser ?? '?', protocolVersion: v['Protocol-Version'] ?? '?' };
  } catch {
    return null;
  }
}

export function isExternal(meta: SessionMetadata): boolean {
  return meta.kind === 'external';
}
