import fs from 'node:fs';
import path from 'node:path';
import * as store from './session-store.js';
import { profileDir } from './session-store.js';
import { allocate } from './port-allocator.js';
import { clearActivePort } from './devtools-port.js';
import { resolveChrome } from './chrome-finder.js';
import { sandboxHint } from './launch-hint.js';
import { buildChromeArgs, spawnChrome, waitForDevTools, releaseChrome, type DevToolsEndpoint } from '../cdp/launch.js';
import { randomBadgeColor } from '../cdp/badge.js';

export interface LaunchOptions {
  name: string;
  port?: number;
  chromeFlags?: string[];
  executablePath?: string;
  headless?: boolean;
  /** Override default profile dir. Caller is responsible for cleanup if ephemeral. */
  userDataDir?: string;
  /** URL appended as final chrome arg — chrome opens it directly, skipping about:blank. */
  bootUrl?: string;
  /**
   * Let extensions run. Off by default, because an extension can change what
   * the page does and this tool exists to observe pages as they are.
   */
  extensions?: boolean;
  /** 세션 뱃지. 생략하면 headful 일 때 켠다. */
  badge?: boolean;
}

/**
 * 번역 제안을 끈다. 프로필의 `Default/Preferences` 에 심는다.
 *
 * `--disable-features=Translate` 로는 부족하다 — 기준 인자에 그것이 있는데도
 * 번역 UI 가 떴고, 프로필에 `translate_ignored_count_for_language` 가 남아 있었다(실측).
 *
 * 번역 버블은 페이지 위에 겹쳐 뜨고 레이아웃을 밀어낸다. 좌표로 클릭하고 스크린샷을
 * 비교하는 도구에서 그것은 관측 대상이 아니라 잡음이다 — 뷰포트를 1920x1080 으로
 * 고정하는 것과 같은 이유로 고정한다.
 *
 * 이미 있는 값은 건드리지 않는다. 사용자가 그 프로필에서 켰다면 그쪽이 나중 의사다.
 */
function seedProfilePrefs(userDataDir: string): void {
  const file = path.join(userDataDir, 'Default', 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    // 아직 없다(첫 기동) 또는 읽을 수 없다 — 어느 쪽이든 새로 쓴다.
  }

  const translate = (prefs.translate ?? {}) as Record<string, unknown>;
  if (translate.enabled !== undefined) return;
  translate.enabled = false;
  prefs.translate = translate;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prefs));
  } catch {
    // 못 써도 기동은 막지 않는다. 번역 버블이 뜰 뿐이다.
  }
}

/**
 * 기동 실패는 chromium stderr 를 그대로 싣고 온다. 거기 적힌 조언(`--no-sandbox` 를
 * 써봐라)을 tirno 문법으로 옮기는 일은 사용자 몫이었다. 그 번역만 얹어서 다시 던진다 —
 * 원문은 건드리지 않는다.
 */
export async function launchOrExplain<O, T>(
  options: O,
  launcher: (o: O) => Promise<T>,
  argv: string[] = process.argv,
): Promise<T> {
  try {
    return await launcher(options);
  } catch (e) {
    const err = e as Error;
    const hint = sandboxHint(err.message, argv);
    if (hint) err.message = `${err.message}${hint}`;
    throw err;
  }
}

interface SpawnSpec {
  executablePath: string;
  args: string[];
  userDataDir: string;
  requestedPort: number;
}

/** 띄우고, DevTools 가 열릴 때까지 기다리고, 핸들을 놓는다. 실패하면 stderr 를 실어 던진다. */
async function spawnAndWait(spec: SpawnSpec): Promise<{ pid: number } & DevToolsEndpoint> {
  const chrome = spawnChrome(spec.executablePath, spec.args);
  try {
    const endpoint = await waitForDevTools(chrome, spec.userDataDir, spec.requestedPort);
    return { pid: chrome.pid, ...endpoint };
  } catch (e) {
    // 떴다가 못 붙은 프로세스는 남기지 않는다 — 대장에 없는 Chrome 은 gc 도 못 본다
    try { chrome.process.kill(); } catch { /* 이미 죽었다 */ }
    throw e;
  } finally {
    releaseChrome(chrome);
  }
}

export async function launch(opts: LaunchOptions): Promise<store.SessionMetadata> {
  // Default to `--remote-debugging-port=0`: the OS picks a free port and chrome
  // records it in DevToolsActivePort. That removes the port-collision class
  // entirely (9222+ is a shared range — other apps squat it) and is what lets a
  // browser MCP anchor on the profile *directory* instead of a port number.
  // An explicit --port keeps the legacy fixed-port path, which writes no
  // DevToolsActivePort and so cannot be an anchor target (`tirno new` warns).
  const requestedPort = opts.port === undefined ? 0 : await allocate(opts.port);
  const executablePath = resolveChrome(opts.executablePath).path;
  const userDataDir = opts.userDataDir ?? profileDir(opts.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  // A previous chrome on this profile left its DevToolsActivePort behind (chrome
  // never removes it — measured, see devtools-port.ts). Clear it first so the
  // file we read back below can only have been written by the chrome we launch.
  clearActivePort(userDataDir);

  seedProfilePrefs(userDataDir);

  // Default viewport 1920x1080 — fixed size is required for tirno's
  // visual cache / journaling to be reproducible. User can override by
  // passing their own `--window-size=...` after `--`; chrome uses the
  // last value on the cmdline.
  //
  // 이것이 대장에 적히는 `chromeFlags` 다 — tirno 가 **명시적으로** 넘긴 것. 기준 인자
  // (BASELINE_ARGS)는 여기 없다: drift 의 재기동 제안과 restart 가 이 목록을 그대로
  // 다시 쓰므로, 기준을 섞으면 두 번 깔린다.
  const args = [
    `--remote-debugging-port=${requestedPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1920,1080',
    '--window-position=0,0',
    ...(opts.chromeFlags ?? []),
  ];

  // 기동은 tirno 가 한다 (cdp/launch.ts). puppeteer 시절 싸우던 것들 — 기본 인자가 우리
  // 포트를 덮고(#33), --disable-extensions 를 되돌릴 수 없고(#113), 프로세스와 함께
  // 브라우저를 죽이는 exit 리스너를 손으로 떼던 일 — 은 여기 없다.
  const fullArgs = buildChromeArgs({
    declared: args,
    userDataDir,
    headless: opts.headless ?? false,
    extensions: opts.extensions ?? false,
    bootUrl: opts.bootUrl,
  });

  const { pid, port, wsEndpoint } = await launchOrExplain(
    { executablePath, args: fullArgs, userDataDir, requestedPort },
    spawnAndWait,
  );

  const headless = opts.headless ?? false;
  // 뱃지는 화면이 있을 때만 뜻이 있다. 색은 여기서 한 번 — connect 마다 바뀌면 뱃지가 아니다.
  const badge = opts.badge ?? !headless;
  const now = new Date().toISOString();
  const meta: store.SessionMetadata = {
    name: opts.name,
    pid,
    port,
    wsEndpoint,
    userDataDir,
    chromeFlags: args,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    ...(opts.extensions ? { extensions: true } : {}),
    ...(headless ? { headless: true } : {}),
    badge,
    ...(badge ? { badgeColor: randomBadgeColor() } : {}),
    createdAt: now,
    lastAccessedAt: now,
    // Pin JS-side viewport to 1920x1080 via setDeviceMetricsOverride. Chrome
    // window-size flag handles the OS window, but the inner viewport differs
    // by chrome bar height; emulation viewport pins it deterministically.
    emulation: store.defaultEmulation(),
  };

  store.create(meta);
  store.setActive(opts.name);

  return meta;
}
