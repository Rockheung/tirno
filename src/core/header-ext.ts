// 세션마다 하나씩 굽는 declarativeNetRequest 확장. `tirno headers` 의 기본 경로다.
//
// Network.setExtraHTTPHeaders 가 CDP 연결 수명에 묶이는 것과 달리, 확장 규칙은
// 브라우저 네트워크 스택에 걸린다. 그래서 tirno 명령이 끝난 뒤 페이지가 스스로
// 보내는 요청, 서비스워커가 보내는 요청, OOPIF 안에서 나가는 요청에도 붙는다(실측).

import fs from 'node:fs';
import path from 'node:path';
import { connect } from './chrome-connector.js';
import { getActivePage } from '../cdp/page-resolver.js';
import * as store from './session-store.js';

/** 헤더 하나와, 그것을 붙일 호스트. `hosts` 가 비면 모든 요청에 붙는다. */
export interface HeaderRule {
  name: string;
  value: string;
  hosts?: string[];
}

// declarativeNetRequest 는 조건이 어긋난 규칙을 조용히 버린다 — 목록에 없는
// resourceType 하나를 적으면 확장은 정상 로드되고 id 까지 돌려주면서 규칙만
// 무효가 되고, 에러는 어디에도 나오지 않는다(실측). 그래서 손으로 고르지 않고
// 전부 건다.
const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
  'websocket', 'webtransport', 'webbundle', 'other',
];

const MANIFEST = {
  manifest_version: 3,
  name: 'tirno-headers',
  version: '1.0',
  permissions: ['declarativeNetRequest'],
  host_permissions: ['<all_urls>'],
  declarative_net_request: {
    rule_resources: [{ id: 'tirno', enabled: true, path: 'rules.json' }],
  },
};

export function buildRules(rules: HeaderRule[]): unknown[] {
  return rules.map((r, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: r.name, operation: 'set', value: r.value }],
    },
    condition: {
      ...(r.hosts?.length ? { requestDomains: r.hosts } : { urlFilter: '*' }),
      resourceTypes: RESOURCE_TYPES,
    },
  }));
}

/**
 * 확장은 프로필 안에 산다. 규칙의 수명은 그 프로필의 수명이어야 하기 때문이다 —
 * `--ephemeral` 세션이면 프로필과 함께 사라지고, `kill --clean` 도 따로 지울 것이 없다.
 */
export function headerExtDir(userDataDir: string): string {
  return path.join(userDataDir, 'tirno-headers');
}

/** 규칙을 디스크에 굽고, chrome 에 넘길 확장 경로를 돌려준다. */
export function writeHeaderExt(userDataDir: string, rules: HeaderRule[]): string {
  const dir = headerExtDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(buildRules(rules), null, 2));
  return dir;
}

/**
 * 규칙을 굽고 확장을 읽힌다. 같은 경로로 다시 불러도 되며, 그때는 리로드된다(실측).
 *
 * 확장은 `Extensions.loadUnpacked` 로만 들어간다. `--load-extension` 은 chrome 152 에서
 * 죽은 경로다 — 플래그가 커맨드라인에 그대로 실려도 확장이 붙지 않고, 프로필 밖 경로 ·
 * `--disable-extensions-except` 동반 · headed · `--disable-features=DisableLoadExtensionCommandLineSwitch`
 * 를 각각 시도해도 마찬가지다(실측). 그리고 loadUnpacked 로 심은 확장은 프로필에 남지
 * 않으므로, 재기동한 세션은 여기를 다시 불러야 규칙이 살아난다.
 *
 * `reload` 는 재기동 직후용이다. 확장은 브라우저가 뜬 뒤에 붙으므로 기동과 함께 연 페이지는
 * 헤더 없이 받아온 것이고, 다시 읽지 않으면 규칙이 있는데 화면에는 없는 상태로 남는다.
 */
export async function loadHeaderExt(sessionName: string, opts: { reload?: boolean } = {}): Promise<void> {
  const meta = store.get(sessionName);
  const dir = writeHeaderExt(meta.userDataDir, meta.headerRules ?? []);
  const { browser } = await connect(sessionName);
  try {
     
    const cdp = await browser.target().createCDPSession();
     
    await ((cdp.send as any)('Extensions.loadUnpacked', { path: dir }) as Promise<unknown>);
    await cdp.detach();
    if (opts.reload) await (await getActivePage(browser)).reload();
  } finally {
    browser.disconnect();
  }
}
