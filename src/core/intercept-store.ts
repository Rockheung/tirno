import * as store from './session-store.js';

/**
 * 요청을 가로채는 규칙.
 *
 * `headers` 는 `Network.setExtraHTTPHeaders` 라 **모든 요청 전역**이고, 호스트 조건을
 * 받지 않는다. 호스트별로 붙이려면 요청마다 URL 을 보고 조건부로 이어보내야 하는데,
 * 그것은 **요청마다 응답을 보내는 상주 연결**을 요구한다 — tirno 는 명령마다 CDP 를
 * 붙였다 끊으므로 CLI 한 방으로는 안 된다 (#122). 그래서 데몬이 있고, 규칙은 여기
 * 세션 메타에 남는다.
 *
 * 규칙이 세션에 사는 이유: 데몬은 죽을 수 있고 재기동될 수 있다. 규칙이 데몬 안에만
 * 있으면 그때마다 사라지고, `ls` 도 데몬이 떠 있을 때만 대답하게 된다.
 *
 * 세 종류를 한 목록으로 둔다. 셋 다 "requestPaused 에서 URL 을 보고 무엇을 할지
 * 정한다" 는 같은 자리이고, 순서가 의미를 갖기 때문이다 — 먼저 걸리는 규칙이 이긴다.
 */

export type RuleKind = 'block' | 'mock' | 'header';

export interface InterceptRule {
  id: string;
  kind: RuleKind;
  /** 호스트 glob. `*.example.com` 은 하위 도메인만, `example.com` 은 그 호스트만. */
  host?: string;
  /** URL glob. 양끝이 열려 있다 — `ads/` 처럼 일부만 적어도 걸린다. */
  url?: string;
  /** mock: 응답 코드. */
  status?: number;
  /** mock: 본문. */
  body?: string;
  /** mock: `content-type`. 없으면 본문에서 추측한다. */
  contentType?: string;
  /** header: 붙일 헤더. */
  headers?: Record<string, string>;
  createdAt: string;
}

/**
 * 호스트 glob. **전체가 맞아야 한다** — `example.com` 이 `evil-example.com.attacker.net`
 * 에 걸리면 그것은 필터가 아니라 사고다.
 *
 * `*` 는 한 조각 이상, `*.` 는 하위 도메인 전용이라 `*.example.com` 이 `example.com`
 * 자신에는 안 걸린다(브라우저 쿠키 규칙과 반대지만, 필터로는 이쪽이 덜 놀랍다 —
 * 상위 도메인까지 같이 걸리길 원하면 두 규칙을 쓰거나 `*example.com` 을 쓴다).
 */
export function matchesHost(hostname: string, pattern: string): boolean {
  if (!pattern) return true;
  const re = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^]*') + '$');
  return re.test(hostname);
}

/** URL glob. `net` 의 `--filter` 와 같은 규칙이다 — 양끝이 열려 있다. */
export function matchesUrl(url: string, pattern: string): boolean {
  if (!pattern) return true;
  if (!/[*?]/.test(pattern)) return url.includes(pattern);
  const re = new RegExp(pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.'));
  return re.test(url);
}

export function ruleMatches(rule: InterceptRule, url: string): boolean {
  if (rule.host) {
    let hostname: string;
    try { hostname = new URL(url).hostname; } catch { return false; }
    if (!matchesHost(hostname, rule.host)) return false;
  }
  if (rule.url && !matchesUrl(url, rule.url)) return false;
  // 조건이 하나도 없는 규칙은 전부에 걸린다. 그것을 만들 수 있는 자리는 CLI 가 막는다.
  return true;
}

export interface Resolution {
  /** 걸린 header 규칙을 전부 합친 것. 뒤 규칙이 같은 헤더를 다시 쓰면 그쪽이 이긴다. */
  headers: Record<string, string>;
  /** 요청의 운명을 정하는 규칙 — block 이거나 mock. 없으면 그냥 나간다. */
  terminal: InterceptRule | null;
  /** 히트로 셀 규칙들. 헤더는 여러 개가 같이 걸릴 수 있다. */
  matched: InterceptRule[];
}

/**
 * 이 URL 에 무엇을 할 것인가.
 *
 * **header 는 block·mock 과 같은 층이 아니다.** 헤더를 붙이는 것은 요청을 끝내지
 * 않으므로, 먼저 걸렸다고 뒤의 차단·모킹을 가리면 안 된다 — 실측으로 밟았다:
 * `headers set X --host localhost` 하나가 그 호스트의 모든 요청을 먹어서, 나중에 건
 * mock 이 영영 안 걸렸다. 규칙은 늘었는데 아무 일도 안 일어나고, 이유는 안 보인다.
 *
 * 그래서 헤더는 **전부 모으고**, 운명은 **처음 걸린 block/mock 하나**가 정한다.
 */
export function resolve(rules: InterceptRule[], url: string): Resolution {
  const headers: Record<string, string> = {};
  const matched: InterceptRule[] = [];
  let terminal: InterceptRule | null = null;

  for (const rule of rules) {
    if (!ruleMatches(rule, url)) continue;
    if (rule.kind === 'header') {
      Object.assign(headers, rule.headers ?? {});
      matched.push(rule);
      continue;
    }
    if (!terminal) {
      terminal = rule;
      matched.push(rule);
    }
  }
  return { headers, terminal, matched };
}

export function list(session: string): InterceptRule[] {
  return store.get(session).intercept ?? [];
}

/** id 는 짧고 사람이 칠 수 있어야 한다 — `intercept rm r3` 가 이 목록의 유일한 지우개다. */
function nextId(rules: InterceptRule[]): string {
  for (let i = 1; ; i++) {
    const id = `r${i}`;
    if (!rules.some(r => r.id === id)) return id;
  }
}

export function add(session: string, rule: Omit<InterceptRule, 'id' | 'createdAt'>): InterceptRule {
  const rules = list(session);
  const full: InterceptRule = { ...rule, id: nextId(rules), createdAt: new Date().toISOString() };
  store.update(session, { intercept: [...rules, full] });
  return full;
}

export function remove(session: string, id: string): boolean {
  const rules = list(session);
  const next = rules.filter(r => r.id !== id);
  if (next.length === rules.length) return false;
  store.update(session, { intercept: next });
  return true;
}

export function clear(session: string): number {
  const n = list(session).length;
  store.update(session, { intercept: [] });
  return n;
}

/** 사람이 읽는 한 줄. `ls` 와 `status` 가 같은 문구를 쓴다. */
export function describe(rule: InterceptRule): string {
  const where = [rule.host && `host ${rule.host}`, rule.url && `url ${rule.url}`]
    .filter(Boolean).join(' + ');
  switch (rule.kind) {
    case 'block': return `block ${where}`;
    case 'mock': return `mock ${where} → ${rule.status}${rule.contentType ? ` ${rule.contentType}` : ''}`;
    case 'header': return `header ${where} → ${Object.entries(rule.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ')}`;
  }
}
