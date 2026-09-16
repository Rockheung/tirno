/**
 * 세션 정책 — 세션을 만들 때 선언하고, 명령마다 지킨다 (#214 · #193).
 *
 * 판단이 아니라 정책이다. tirno 안에 LLM 이 없다는 선과 맞는다 — 무엇을 허용할지는 호출자가
 * 세션을 만들 때 정하고, tirno 는 그것을 매 명령에서 확인만 한다. 두 층이다:
 *
 * 1. **CLI 층**(이 파일): 명령 진입 전에 argv 만 보고 거절한다. stateless 로 된다. 볼 수 있는
 *    것은 URL 인자와 role+이름 대상뿐이다 — 셀렉터·@N 뒤의 요소가 무엇인지는 모른다.
 * 2. **브라우저 층**(header-ext): declarativeNetRequest 차단 규칙. 스크립트가 여는 이동·XHR·
 *    beacon 까지 막는다. `--allow` 는 이 층이 있어야 온전하므로 확장을 켠 채로 뜬다.
 */

export interface Policy {
  /** 허용 도메인. 부분 도메인은 그 아래 전부 (`a.com` 은 `x.a.com` 도) */
  allowDomains?: string[];
  /** 페이지를 바꾸는 명령 거부 */
  readOnly?: boolean;
  /** 파괴적으로 보이는 이름의 대상은 `--confirm` 없이 누르지 않는다 */
  confirmDestructive?: boolean;
  /** 사용자 정규식 — confirmDestructive 의 목록에 덧붙인다 */
  destructivePattern?: string;
}

/** 페이지 상태를 바꾸는 명령 — read-only 세션이 거부한다 */
export const MUTATING = new Set(['click', 'fill', 'type', 'press', 'upload', 'drag', 'select', 'eval', 'ensure', 'apply', 'recipe', 'replay', 'inject', 'cdp']);

/** URL 을 첫 positional 로 받는 명령 — allowDomains 가 본다 */
const URL_COMMANDS = new Set(['nav', 'new', 'new-tab', 'restart']);

/**
 * 결제·삭제·전송류. 보수적으로 — 오탐은 `--confirm` 으로 넘기면 된다. 영어와 한국어.
 */
export const DESTRUCTIVE_WORDS = /\b(delete|remove|destroy|erase|drop|purchase|buy now|pay|checkout|place order|submit order|confirm order|transfer|send money|wire|unsubscribe|cancel (?:subscription|account|order)|deactivate|close account|revoke|wipe|reset password|format)\b|삭제|제거|결제|구매|주문|송금|이체|탈퇴|해지|초기화/i;

export interface Denial { code: 'policy_denied'; message: string; policy: keyof Policy }

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

/** `a.com` 은 a.com 과 *.a.com. `*.a.com` 도 같은 뜻으로 받는다. */
export function domainAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  return allow.some(raw => {
    const d = raw.toLowerCase().replace(/^\*\./, '');
    return h === d || h.endsWith(`.${d}`);
  });
}

/** 대상 이름이 파괴적으로 보이는가 */
export function looksDestructive(name: string, extra?: string): string | null {
  const m = DESTRUCTIVE_WORDS.exec(name);
  if (m) return m[0];
  if (extra) {
    try { const e = new RegExp(extra, 'i').exec(name); if (e) return e[0]; } catch { /* 사용자 정규식이 틀리면 무시 */ }
  }
  return null;
}

export interface CheckInput {
  command: string;
  argv: string[];
  /** @N → 이름 (ref store) */
  nameOfRef?: (ref: string) => string | undefined;
  /** 명령이 `--confirm` 을 받았나 */
  confirmed?: boolean;
  /** `eval --allow-eval` */
  allowEval?: boolean;
}

/**
 * 명령 진입 전 판정. 통과면 null.
 */
export function checkPolicy(policy: Policy | undefined, input: CheckInput): Denial | null {
  if (!policy) return null;
  const { command, argv } = input;
  const positional = argv.filter(a => !a.startsWith('-'));

  if (policy.readOnly && MUTATING.has(command)) {
    if (command === 'eval' && input.allowEval) { /* 명시적으로 허용 */ } else {
      return { code: 'policy_denied', policy: 'readOnly', message: `session is read-only — \`${command}\` changes the page. Observe with snapshot/expect/forms/read, or make a session without --read-only${command === 'eval' ? ' (or pass --allow-eval)' : ''}` };
    }
  }

  if (policy.allowDomains?.length) {
    const urls = URL_COMMANDS.has(command) ? positional.filter(p => /^https?:\/\//i.test(p)) : [];
    if (command === 'ensure' && positional[0] === 'url' && positional[1]) urls.push(positional[1]);
    for (const u of urls) {
      const host = hostOf(u);
      if (host && !domainAllowed(host, policy.allowDomains)) {
        return { code: 'policy_denied', policy: 'allowDomains', message: `${host} is outside --allow (${policy.allowDomains.join(', ')}) — this session does not leave those domains` };
      }
    }
  }

  if (policy.confirmDestructive && !input.confirmed && ['click', 'ensure', 'press'].includes(command)) {
    // role + 이름, 또는 @N 의 저장된 이름. 셀렉터 뒤의 이름은 여기서 모른다.
    let name: string | undefined;
    if (command === 'click' && positional[1] !== undefined && /^[a-z]+$/i.test(positional[0]) && !positional[0].startsWith('@')) name = positional[1];
    else if (command === 'click' && positional[0]?.startsWith('@')) name = input.nameOfRef?.(positional[0]);
    else if (command === 'ensure') name = positional.find((p, i) => i > 0 && /^[A-Za-z]/.test(p) && !['checked', 'unchecked', 'focused', 'url', 'value', 'visible', 'hidden', 'text'].includes(p));
    if (command === 'press' && /^enter$/i.test(positional[0] ?? '')) name = undefined;   // Enter 는 이름이 없다 — 막지 않는다
    const hit = name ? looksDestructive(name, policy.destructivePattern) : null;
    if (hit) {
      return { code: 'policy_denied', policy: 'confirmDestructive', message: `"${name}" looks destructive (${hit}) — this session requires --confirm to act on it` };
    }
  }
  return null;
}

/** `ls` 의 POLICY 열 */
export function describePolicy(p: Policy | undefined): string {
  if (!p) return '-';
  const parts: string[] = [];
  if (p.allowDomains?.length) parts.push(`allow:${p.allowDomains.join(',')}`);
  if (p.readOnly) parts.push('read-only');
  if (p.confirmDestructive) parts.push('confirm-destructive');
  return parts.join(' ') || '-';
}

/** WebRTC 는 dNR 밖이다 — 허용 목록이 있으면 UDP 로 새는 길을 막는 플래그를 같이 넣는다 */
export const WEBRTC_CONTAINMENT_FLAGS = ['--webrtc-ip-handling-policy=disable_non_proxied_udp', '--force-webrtc-ip-handling-policy'];
