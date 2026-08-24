import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { underRoot } from './paths.js';
import { isRunnable, setConfiguredChrome } from './chrome-finder.js';
import { unzip } from './unzip.js';

/**
 * Chrome 을 **찾는 대신 받아온다.**
 *
 * tirno 의 셀링 포인트는 "바이너리에 런타임이 들어 있어 Node 를 안 깔아도 된다" 인데,
 * 런타임 의존성을 없앤 자리를 브라우저 의존성이 그대로 채우고 있었다. linux-arm64 에는
 * Google Chrome 이 아예 없어서, 사용자가 Chromium 을 어디서 어떻게 가져올지부터
 * 판단해야 한다 — 실제로 Playwright 로 받고 sudo 로 심링크를 깔았다. **툴 설치 비용보다
 * 전제조건 설치 비용이 컸다** (#139).
 *
 * 받은 것은 `~/.tirno/chrome/` 아래 둔다. 시스템 경로에 손대지 않으므로 sudo 가 전혀
 * 필요 없다 — 자동 탐색이 실패했을 때 사용자가 그쪽으로 몰리는 것이 문제였다.
 *
 * 출처가 둘인 것은 구글 사정이다:
 *
 * - **Chrome for Testing** (googlechromelabs) — linux64 · mac-arm64 · mac-x64.
 *   버전 API 가 깔끔하고 구글이 직접 낸다.
 * - **Playwright CDN** — **linux-arm64 는 여기뿐이다.** 구글은 리눅스용을 amd64 로만
 *   배포하고, Chrome for Testing 의 플랫폼 목록에도 arm64 리눅스가 없다(실측:
 *   linux64/mac-arm64/mac-x64/win32/win64). Playwright 는 그 자리만 자기가 빌드한다.
 */

const CFT_VERSIONS = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const PLAYWRIGHT_CDN = 'https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium';
/** Playwright 가 linux-arm64 용으로 내는 chromium. browsers.json 의 revision 과 같은 번호다. */
const PLAYWRIGHT_REVISION = '1234';
const PLAYWRIGHT_VERSION = '151.0.7922.34';

export interface Plan {
  /** 어디서 받나. 사용자에게 그대로 보여준다 — 어디서 온 바이너리인지는 알 권리다. */
  source: 'chrome-for-testing' | 'playwright';
  url: string;
  /** 설치될 디렉터리 이름. */
  label: string;
  /** 압축을 푼 뒤 실행 파일이 있을 상대 경로 후보. */
  binaryCandidates: string[];
  version: string;
}

export function chromeRoot(): string {
  return underRoot('chrome');
}

/** tirno 가 릴리즈하는 타깃과 같은 집합. Windows 는 이 도구의 대상이 아니다. */
export function platformKey(platform = process.platform, arch = process.arch): string | null {
  if (platform === 'linux' && arch === 'x64') return 'linux64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64';
  return null;
}

interface CftFeed {
  channels: Record<string, {
    version: string;
    downloads: { chrome: Array<{ platform: string; url: string }> };
  }>;
}

/** linux-arm64 만 Playwright 로 간다. 나머지는 구글이 직접 내는 것을 쓴다. */
export async function plan(key: string, fetchImpl: typeof fetch = fetch): Promise<Plan> {
  if (key === 'linux-arm64') {
    return {
      source: 'playwright',
      url: `${PLAYWRIGHT_CDN}/${PLAYWRIGHT_REVISION}/chromium-linux-arm64.zip`,
      label: `chromium-${PLAYWRIGHT_REVISION}`,
      version: PLAYWRIGHT_VERSION,
      binaryCandidates: ['chrome-linux/chrome', 'chrome-linux64/chrome'],
    };
  }

  const res = await fetchImpl(CFT_VERSIONS);
  if (!res.ok) throw new Error(`Chrome for Testing version feed said ${res.status}`);
  const feed = await res.json() as CftFeed;
  const stable = feed.channels['Stable'];
  if (!stable) throw new Error('Chrome for Testing feed has no Stable channel');
  const download = stable.downloads.chrome.find(d => d.platform === key);
  if (!download) {
    throw new Error(`Chrome for Testing does not build ${key} (it has: ${stable.downloads.chrome.map(d => d.platform).join(', ')})`);
  }
  return {
    source: 'chrome-for-testing',
    url: download.url,
    label: `chrome-${stable.version}`,
    version: stable.version,
    binaryCandidates: [
      'chrome-linux64/chrome',
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ],
  };
}

/** 압축을 푼 트리에서 실행 파일을 찾는다. 후보가 다 빗나가면 훑어서라도 찾는다. */
export function findBinary(root: string, candidates: string[]): string | null {
  for (const rel of candidates) {
    const p = path.join(root, rel);
    if (isRunnable(p)) return p;
  }
  const names = new Set(['chrome', 'Google Chrome for Testing', 'Chromium']);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (names.has(e.name) && isRunnable(p)) return p;
    }
  }
  return null;
}

export interface InstallResult {
  binary: string;
  label: string;
  bytes: number;
  files: number;
}

/**
 * 받아서 풀고, **돌아가는지 확인한 다음에** 설정에 적는다. 확인 없이 적으면 다음 `new`
 * 가 실패하고, 그 실패는 프로비저닝이 아니라 tirno 의 버그처럼 읽힌다.
 */
export async function install(
  p: Plan,
  hooks: { onProgress?: (received: number, total: number) => void } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<InstallResult> {
  const root = chromeRoot();
  const dest = path.join(root, p.label);
  fs.mkdirSync(root, { recursive: true });

  const res = await fetchImpl(p.url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') ?? 0);

  const tmp = fs.mkdtempSync(path.join(root, '.download-'));
  const archive = path.join(tmp, 'browser.zip');
  try {
    const out = fs.createWriteStream(archive);
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) await new Promise<void>(r => out.once('drain', () => r()));
      hooks.onProgress?.(received, total);
    }
    await new Promise<void>((resolve, reject) => out.end(() => resolve()).on('error', reject));

    // 반쯤 풀린 옛 설치가 남아 있으면 findBinary 가 그것을 집는다. 새로 푼다.
    fs.rmSync(dest, { recursive: true, force: true });
    const extracted = unzip(archive, dest);

    const binary = findBinary(dest, p.binaryCandidates);
    if (!binary) {
      throw new Error(`Extracted ${extracted.files} files to ${dest} but found no chrome executable in them`);
    }
    return { binary, label: p.label, bytes: received, files: extracted.files };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function remember(binary: string): void {
  setConfiguredChrome(binary);
}

/**
 * 받아온 바이너리 경로를 아는 것은 tirno 뿐이다 — 그러면 스니펫도 채워줄 수 있다 (#134).
 *
 * 심링크는 끝까지 따라간다. AppArmor 는 **실행되는 그 파일**의 경로로 프로파일을 붙이므로,
 * `/usr/bin/chromium-browser` 처럼 링크를 적으면 프로파일이 아무 데도 안 걸린다.
 */
export function apparmorProfile(binaryPath: string): string {
  let binary = binaryPath;
  try { binary = fs.realpathSync(binaryPath); } catch { /* 못 따라가면 준 대로 쓴다 */ }
  return [
    `# /etc/apparmor.d/tirno-chromium`,
    `abi <abi/4.0>,`,
    `include <tunables/global>`,
    `profile tirno-chromium ${binary} flags=(unconfined) {`,
    `  userns,`,
    `}`,
  ].join('\n');
}

/** Ubuntu 23.10+ 는 비특권 user namespace 를 막아서 chromium 샌드박스가 못 뜬다. */
export function usernsRestricted(): boolean {
  try {
    return fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf-8').trim() === '1';
  } catch {
    return false;
  }
}

export function listInstalled(): Array<{ label: string; binary: string | null }> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(chromeRoot(), { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ label: e.name, binary: findBinary(path.join(chromeRoot(), e.name), []) }));
}

export function humanBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)}MB`;
  return `${Math.round(n / 1024)}KB`;
}

export function tmpdirIsWritable(): boolean {
  try {
    fs.accessSync(os.tmpdir(), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
