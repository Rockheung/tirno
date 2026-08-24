import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { underRoot } from './paths.js';

/**
 * 어느 Chrome 을 쓸 것인가.
 *
 * 예전에는 고정 경로 4개를 순서대로 `existsSync` 하는 것이 전부였고, 그 4개는
 * macOS 1개 + `google-chrome`/`google-chrome-stable`/`chromium-browser` 였다.
 * **linux-arm64 에서는 그중 성립 가능한 것이 0개다** — 구글은 리눅스용 Chrome 을
 * amd64 로만 배포하고, Ubuntu 24.04 의 chromium 은 snap 이라 `/usr/bin/chromium-browser`
 * 가 아니다. 릴리즈에 `tirno-bun-linux-arm64` 를 올려두고 그 플랫폼에서 탐색이
 * 구조적으로 실패하는 상태였다(#133).
 *
 * 그래서 세 가지를 바꾼다:
 *
 * 1. **환경변수를 본다.** 예전 `findChrome()` 은 env 를 아예 조회하지 않았다.
 * 2. **탐색 목록에 실제로 arm64 에 존재하는 것들을 넣는다** — 배포판 chromium,
 *    snap, 그리고 playwright/puppeteer 가 받아둔 빌드(둘 다 arm64 빌드를 낸다).
 * 3. **한 번 정한 경로를 적어둘 자리를 준다** (`tirno chrome set`). 매 `new` 마다
 *    `--executable-path` 를 다시 주는 것이 실사용에서 제일 아팠던 부분이고,
 *    적어둘 곳이 없으면 사용자는 sudo 로 심링크를 까는 쪽으로 간다 — 도구가
 *    요구하는 설치 비용이 도구 자신의 설치 비용보다 커진다.
 *
 * 순서는 **구체적인 것이 이긴다**: 인자 → env → 적어둔 설정 → 탐색.
 */

/** 우선순위 순. 앞의 것이 이긴다. */
const ENV_VARS = ['TIRNO_CHROME', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH'];

/**
 * 고정 경로. `*` 는 한 세그먼트 안에서만 매칭한다 (glob 라이브러리를 붙이지 않는다 —
 * 필요한 것은 `chromium-1234` 같은 버전 디렉터리 하나뿐이다).
 *
 * playwright/puppeteer 캐시가 목록에 있는 이유: 그 둘은 arm64 리눅스 빌드를 내려받고,
 * 이미 받아둔 사람이 많다. 즉 **arm64 에서 유일하게 이미 존재할 가능성이 있는 경로**다.
 */
export function chromeCandidates(platform: string = process.platform, home: string = os.homedir()): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      `${home}/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium`,
      `${home}/.cache/puppeteer/chrome/*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    ];
  }
  if (platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    return [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',          // Debian/Fedora 의 패키지명
    '/usr/bin/chromium-browser',  // Ubuntu 22.04 이전 / 일부 배포판
    '/snap/bin/chromium',         // Ubuntu 24.04 의 chromium 은 snap 이다
    '/usr/lib/chromium/chromium',
    `${home}/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`,
    `${home}/.cache/puppeteer/chrome/*/chrome-linux*/chrome`,
  ];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 버전 디렉터리는 사전순이 아니라 숫자순으로 최신이 앞이어야 한다 —
 * `chromium-1200` 은 `chromium-999` 보다 뒤가 아니라 앞이다.
 */
function newestFirst(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

/** 세그먼트 단위 `*` 만 지원하는 최소 glob. 매칭이 없으면 빈 배열. */
export function expandGlob(pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern];
  const segments = pattern.split('/').filter(s => s.length > 0);
  let current: string[] = [pattern.startsWith('/') ? '/' : '.'];
  for (const seg of segments) {
    const next: string[] = [];
    if (seg.includes('*')) {
      const re = new RegExp('^' + seg.split('*').map(escapeRe).join('[^/]*') + '$');
      for (const base of current) {
        let entries: string[];
        try { entries = fs.readdirSync(base); } catch { continue; }
        for (const entry of entries.filter(e => re.test(e)).sort(newestFirst)) {
          next.push(path.join(base, entry));
        }
      }
    } else {
      for (const base of current) {
        const p = path.join(base, seg);
        if (fs.existsSync(p)) next.push(p);
      }
    }
    if (next.length === 0) return [];
    current = next;
  }
  return current;
}

/**
 * 존재만으로는 부족하다 — `/usr/bin/chromium` 이 디렉터리이거나 실행 권한이 없으면
 * 기동은 어차피 실패한다. 그 실패는 "Chrome 을 못 찾았다" 보다 훨씬 읽기 어렵다.
 */
export function isRunnable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ChromeConfig {
  /** `tirno chrome set` 이 적어둔 실행 파일 경로. */
  chromePath?: string;
}

export function configPath(): string {
  return underRoot('config.json');
}

export function readConfig(): ChromeConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as ChromeConfig;
  } catch {
    return {};
  }
}

function writeConfig(cfg: ChromeConfig): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

export function setConfiguredChrome(p: string): string {
  const resolved = path.resolve(p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
  if (!isRunnable(resolved)) {
    throw new Error(`Not an executable file: ${resolved}`);
  }
  writeConfig({ ...readConfig(), chromePath: resolved });
  return resolved;
}

export function clearConfiguredChrome(): boolean {
  const cfg = readConfig();
  if (!cfg.chromePath) return false;
  delete cfg.chromePath;
  writeConfig(cfg);
  return true;
}

export type ChromeSource =
  | { kind: 'flag' }
  | { kind: 'env'; name: string }
  | { kind: 'config' }
  | { kind: 'search'; pattern: string };

export interface ChromeResolution {
  path: string;
  source: ChromeSource;
}

export function describeSource(source: ChromeSource): string {
  switch (source.kind) {
    case 'flag': return '--executable-path';
    case 'env': return `$${source.name}`;
    case 'config': return `${configPath()} (tirno chrome set)`;
    case 'search': return source.pattern;
  }
}

/**
 * 후보를 순서대로 훑되, **왜 그것이 뽑혔는지도 같이 돌려준다.** `tirno chrome` 이
 * 그 근거를 그대로 출력하고, 실패 메시지도 같은 목록으로 만든다 — 무엇을 봤는지
 * 안 알려주는 "Chrome not found" 가 이 이슈의 절반이었다.
 *
 * env 와 설정은 **존재하지 않아도 건너뛰지 않는다.** 사용자가 명시적으로 가리킨
 * 경로가 틀렸다면, 조용히 다른 chrome 으로 넘어가는 것이 아니라 그 사실을 말해야 한다.
 */
export function resolveChrome(explicit?: string): ChromeResolution {
  if (explicit) {
    if (!isRunnable(explicit)) throw new Error(`--executable-path is not an executable file: ${explicit}`);
    return { path: explicit, source: { kind: 'flag' } };
  }

  for (const name of ENV_VARS) {
    const value = process.env[name];
    if (!value) continue;
    if (!isRunnable(value)) throw new Error(`$${name} is not an executable file: ${value}`);
    return { path: value, source: { kind: 'env', name } };
  }

  const configured = readConfig().chromePath;
  if (configured) {
    if (!isRunnable(configured)) {
      throw new Error(
        `Configured chrome is gone: ${configured}\n` +
        `  Fix it with: tirno chrome set <path>   (or clear it: tirno chrome rm)`
      );
    }
    return { path: configured, source: { kind: 'config' } };
  }

  for (const pattern of chromeCandidates()) {
    for (const candidate of expandGlob(pattern)) {
      if (isRunnable(candidate)) return { path: candidate, source: { kind: 'search', pattern } };
    }
  }

  throw new Error(notFoundMessage());
}

export function notFoundMessage(): string {
  const searched = chromeCandidates().map(p => `    ${p}`).join('\n');
  return [
    'Chrome not found.',
    `  Searched (in order): $${ENV_VARS.join(', $')}, ${configPath()}, then:`,
    searched,
    '',
    '  Point tirno at one, once:',
    '    tirno chrome set /path/to/chrome        # 적어두면 이후 세션은 안 물어본다',
    '  Or per session: tirno new <name> --executable-path /path/to/chrome',
    '  Or per shell:   export TIRNO_CHROME=/path/to/chrome',
    '',
    '  linux-arm64 에는 Google Chrome 자체가 없다 (구글은 amd64 만 배포한다).',
    '  chromium 을 쓰거나, playwright/puppeteer 가 받아둔 arm64 빌드를 가리켜라:',
    '    npx playwright install chromium',
  ].join('\n');
}

export interface CandidateReport {
  /** 표시용 출처 이름. */
  source: string;
  /** 그 출처가 가리킨 경로. 탐색인데 매칭이 없으면 패턴 자체. */
  path: string;
  status: 'ok' | 'missing' | 'not-executable' | 'unset';
}

/** `tirno chrome` 이 출력하는 표. 판정과 같은 순서·같은 규칙으로 만든다. */
export function inspectCandidates(): CandidateReport[] {
  const rows: CandidateReport[] = [];

  for (const name of ENV_VARS) {
    const value = process.env[name];
    if (!value) {
      rows.push({ source: `$${name}`, path: '-', status: 'unset' });
      continue;
    }
    rows.push({ source: `$${name}`, path: value, status: statusOf(value) });
  }

  const configured = readConfig().chromePath;
  rows.push(configured
    ? { source: 'config', path: configured, status: statusOf(configured) }
    : { source: 'config', path: '-', status: 'unset' });

  for (const pattern of chromeCandidates()) {
    const matches = expandGlob(pattern);
    if (matches.length === 0) {
      rows.push({ source: 'search', path: pattern, status: 'missing' });
      continue;
    }
    for (const m of matches) rows.push({ source: 'search', path: m, status: statusOf(m) });
  }

  return rows;
}

function statusOf(p: string): CandidateReport['status'] {
  if (!fs.existsSync(p)) return 'missing';
  return isRunnable(p) ? 'ok' : 'not-executable';
}
