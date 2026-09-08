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

// `action` 과 `background` 는 규칙을 거는 것과 무관하다 — 창을 보는 사람이 지금 어떤
// 헤더가 붙는지 알 수 있게 하는 UI 다(#167). 권한은 늘지 않는다: MV3 의 chrome.action
// 은 권한을 요구하지 않고, 팝업은 자기 확장 안의 view.json 만 읽는다.
const MANIFEST = {
  manifest_version: 3,
  name: 'tirno-headers',
  version: '1.0',
  permissions: ['declarativeNetRequest'],
  host_permissions: ['<all_urls>'],
  declarative_net_request: {
    rule_resources: [{ id: 'tirno', enabled: true, path: 'rules.json' }],
  },
  action: { default_popup: 'popup.html', default_title: 'Fixed request headers (tirno)' },
  background: { service_worker: 'bg.js' },
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

/**
 * 팝업이 읽는 표. `rules.json` 은 declarativeNetRequest 의 형식이라 사람이 읽을
 * 것이 아니고, 앞으로 그 형식이 바뀌어도 팝업이 따라 깨지면 안 된다.
 */
export function buildView(rules: HeaderRule[]): unknown[] {
  return rules.map(r => ({
    name: r.name,
    value: r.value,
    hosts: r.hosts?.length ? r.hosts : null,   // null = 모든 호스트
  }));
}

// 뱃지는 규칙 개수다. 0 이면 비운다 — "0" 을 띄우면 헤더가 붙는 세션과 안 붙는
// 세션이 둘 다 뱃지를 달게 되고, 그러면 뱃지가 가르는 것이 없어진다.
const BG_JS = `// 생성된 파일 — tirno headers.
async function paint() {
  let n = 0;
  try {
    const view = await (await fetch(chrome.runtime.getURL('view.json'))).json();
    n = view.length;
  } catch { n = 0; }
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
  await chrome.action.setTitle({
    title: n ? \`tirno — \${n} fixed header\${n === 1 ? '' : 's'} on this session\`
             : 'tirno — no fixed headers on this session',
  });
}
paint();
chrome.runtime.onInstalled.addListener(paint);
chrome.runtime.onStartup.addListener(paint);
`;

// 팝업은 페이지를 건드리지 않는다 — 관측이 대상을 오염시키지 않는 것이 이 방식을
// 고른 이유다(#167 의 제안 1번).
const POPUP_HTML = `<!doctype html>
<meta charset="utf-8">
<title>tirno headers</title>
<link rel="stylesheet" href="popup.css">
<h1>Fixed request headers</h1>
<div id="list"></div>
<p class="note">
  Values are masked — click one to reveal. These are declarativeNetRequest rules
  baked into this session profile, so they hold after tirno disconnects.
</p>
<p class="note">
  <code>--once</code> headers cannot appear here: they live in the CDP connection,
  not in this extension. Run <code>tirno headers ls</code> to see those.
</p>
<script src="popup.js"></script>
`;

const POPUP_CSS = `body { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
  margin: 0; padding: 12px; min-width: 340px; background: #fff; color: #111; }
h1 { font-size: 13px; margin: 0 0 10px; letter-spacing: .02em; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase;
  letter-spacing: .04em; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding: 4px 6px 4px 0; }
td { padding: 5px 6px 5px 0; border-bottom: 1px solid #f3f4f6; vertical-align: top;
  word-break: break-all; }
.value { cursor: pointer; color: #b91c1c; }
.value.revealed { color: #111; }
.hosts { color: #6b7280; }
.empty { color: #6b7280; padding: 6px 0; }
.note { color: #6b7280; font-size: 11px; line-height: 1.5; margin: 10px 0 0; }
code { background: #f3f4f6; padding: 0 3px; border-radius: 2px; }
@media (prefers-color-scheme: dark) {
  body { background: #18181b; color: #e4e4e7; }
  th { color: #a1a1aa; border-bottom-color: #3f3f46; }
  td { border-bottom-color: #27272a; }
  .value { color: #f87171; } .value.revealed { color: #e4e4e7; }
  .hosts, .empty, .note { color: #a1a1aa; }
  code { background: #27272a; }
}
`;

// 값은 기본 마스킹한다. 헤더 값은 토큰인 경우가 흔하고, 팝업은 사람이 어깨너머로
// 보는 화면 위에 뜬다. 길이는 남긴다 — 무엇이 들었는지는 가리되 비었는지 아닌지는
// 보여야 "붙어 있나" 라는 질문에 답이 된다.
const POPUP_JS = `// 생성된 파일 — tirno headers.
const mask = v => '\u2022'.repeat(Math.min(v.length, 24)) + (v.length > 24 ? '\u2026' : '');

function render(view) {
  const list = document.getElementById('list');
  if (!view.length) {
    list.innerHTML = '<p class="empty">No fixed headers on this session.</p>';
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = '<tr><th>Header</th><th>Value</th><th>Hosts</th></tr>';
  for (const r of view) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.textContent = r.name;

    const value = document.createElement('td');
    value.className = 'value';
    value.textContent = mask(r.value);
    value.title = 'click to reveal';
    value.addEventListener('click', () => {
      const shown = value.classList.toggle('revealed');
      value.textContent = shown ? r.value : mask(r.value);
      value.title = shown ? 'click to hide' : 'click to reveal';
    });

    const hosts = document.createElement('td');
    hosts.className = 'hosts';
    hosts.textContent = r.hosts ? r.hosts.join(', ') : 'every host';

    tr.append(name, value, hosts);
    table.append(tr);
  }
  list.replaceChildren(table);
}

fetch(chrome.runtime.getURL('view.json'))
  .then(r => r.json())
  .then(render)
  .catch(e => {
    document.getElementById('list').textContent = 'could not read rules: ' + e.message;
  });
`;

/** 규칙을 디스크에 굽고, chrome 에 넘길 확장 경로를 돌려준다. */
export function writeHeaderExt(userDataDir: string, rules: HeaderRule[]): string {
  const dir = headerExtDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST, null, 2));
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(buildRules(rules), null, 2));
  // 창 안에서 보이게 하는 쪽. 규칙과 같은 호출에서 함께 써야 뱃지가 규칙보다
  // 낡지 않는다.
  fs.writeFileSync(path.join(dir, 'view.json'), JSON.stringify(buildView(rules), null, 2));
  fs.writeFileSync(path.join(dir, 'bg.js'), BG_JS);
  fs.writeFileSync(path.join(dir, 'popup.html'), POPUP_HTML);
  fs.writeFileSync(path.join(dir, 'popup.css'), POPUP_CSS);
  fs.writeFileSync(path.join(dir, 'popup.js'), POPUP_JS);
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
