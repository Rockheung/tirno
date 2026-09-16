/**
 * drift 의 다른 축 — 플래그 말고도 "적용했다" 고 적어 둔 것들 (#192).
 *
 * 세션 메타의 주장 중 기동 뒤에 조용히 어긋날 수 있는 것 둘:
 *
 * - **확장**: `headers set` 과 `--allow` 는 확장으로 산다. `Extensions.loadUnpacked` 로 얹은
 *   확장은 프로필에 남지 않아 Chrome 이 다시 뜨면 사라진다 — 규칙은 메타에 그대로인데
 *   요청에는 안 붙는 상태. `Target.getTargets` 의 확장 타깃 수로 본다.
 * - **prefs**: `new` 가 심는 `translate.enabled=false`. 다른 Chrome 이 그 프로필을 열었다
 *   닫으면 바뀔 수 있다. 남이 바꾼 값은 "그쪽이 나중 의사" 라 drift 가 아니라 표시만.
 *
 * emulation 은 축이 아니다 — 오버라이드는 연결 수명이라 connect 마다 메타에서 다시 적용된다.
 * 새 연결로 재 보면 늘 "적용 안 됨" 이고, 그것은 설계지 drift 가 아니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SessionMetadata } from './session-store.js';
import type { Browser } from '../cdp/browser.js';

export interface Axis {
  axis: 'extensions' | 'prefs';
  status: 'ok' | 'drift' | 'changed-by-user' | 'n/a';
  expected: string;
  actual: string;
  fix?: string;
}

/** 이 세션이 확장을 기대하는가 — 헤더 규칙이나 허용 목록이 있으면 */
export function expectsExtension(meta: SessionMetadata): string | null {
  const parts: string[] = [];
  if (meta.headerRules?.length) parts.push(`${meta.headerRules.length} header rule${meta.headerRules.length === 1 ? '' : 's'}`);
  if (meta.policy?.allowDomains?.length) parts.push(`allow ${meta.policy.allowDomains.join(',')}`);
  return parts.length ? parts.join(' · ') : null;
}

export async function checkExtensions(browser: Browser, meta: SessionMetadata): Promise<Axis> {
  const expected = expectsExtension(meta);
  if (!expected) return { axis: 'extensions', status: 'n/a', expected: 'none declared', actual: '—' };
  const targets = await browser.targets();
  const ext = targets.filter(t => (t.type() === 'service_worker' || t.type() === 'background_page') && t.url().startsWith('chrome-extension://'));
  if (ext.length > 0) return { axis: 'extensions', status: 'ok', expected: `${expected} (extension loaded)`, actual: `${ext.length} extension target${ext.length === 1 ? '' : 's'}` };
  return {
    axis: 'extensions', status: 'drift',
    expected: `${expected} — the tirno-headers extension must be loaded`,
    actual: 'Target.getTargets shows 0 extension targets — rules are in the ledger but not in the browser',
    fix: meta.headerRules?.length ? `tirno headers set … (re-set any rule reloads the extension) or tirno restart ${meta.name}` : `tirno restart ${meta.name}`,
  };
}

export function checkPrefs(meta: SessionMetadata): Axis {
  const file = path.join(meta.userDataDir, 'Default', 'Preferences');
  let prefs: { translate?: { enabled?: unknown } };
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof prefs;
  } catch {
    return { axis: 'prefs', status: 'n/a', expected: 'translate.enabled=false', actual: 'Preferences not readable' };
  }
  const v = prefs.translate?.enabled;
  if (v === false) return { axis: 'prefs', status: 'ok', expected: 'translate.enabled=false', actual: 'translate.enabled=false' };
  // 심은 값이 바뀌었다 — 누군가의 의사다. drift 로 세지 않고 말만 한다.
  return { axis: 'prefs', status: 'changed-by-user', expected: 'translate.enabled=false (seeded by tirno)', actual: `translate.enabled=${JSON.stringify(v)} — someone changed it in this profile; tirno leaves it` };
}
