/**
 * Chrome 을 직접 띄운다 — puppeteer.launch 없이 (#182 2단계).
 *
 * puppeteer 가 기동을 맡았을 때 tirno 는 그 기본 인자와 싸웠다: `--remote-debugging-port=0`
 * 이 `-p` 를 덮었고(#33), `--disable-extensions` 는 뒤에서 되돌릴 수 없었고(#113),
 * `--disable-features=Translate` 를 넣어 줬는데도 번역 UI 가 떴다. 그리고 puppeteer 는
 * 브라우저가 자기 프로세스와 함께 죽는다고 가정해 exit 리스너를 셋 걸었고, 세션이 CLI 를
 * 넘겨 살아야 하는 tirno 는 그것을 손으로 떼어냈다. 여기서는 인자도 수명도 tirno 것이다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readActivePort } from '../core/devtools-port.js';

/**
 * 모든 세션에 깔리는 기준 인자. puppeteer 의 기본값에서 **이유가 있는 것만** 남겼다 —
 * 각 줄의 이유가 그 줄을 지키는 근거고, 이유가 없어지면 줄도 지운다.
 *
 * 대장(`meta.chromeFlags`)에는 넣지 않는다. 거기 들어가면 `drift` 가 제안하는 재기동
 * 명령에 30줄이 따라붙고, `restart` 가 그것을 다시 받아 두 번 깔린다. `drift` 는 선언에
 * 없는 실행 중 플래그를 보고하지 않으므로 여기 것은 조용히 지나간다 — puppeteer 시절과 같다.
 */
export const BASELINE_ARGS: readonly string[] = [
  // 관측 도구다 — 브라우저가 스스로 하는 네트워크(컴포넌트 갱신·세이프브라우징·동기화·
  // 기본 앱)는 페이지의 것이 아니라 잡음이고, network 캡처와 HAR 에 섞인다
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--disable-sync',
  '--metrics-recording-only',
  // 백그라운드 탭에서도 명령이 돌아야 한다 — eval·snapshot 은 앞에 안 가져오고 쓴다
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // 멈춘 렌더러를 크롬이 스스로 죽이면 perf 진단이 대상을 잃는다
  '--disable-hang-monitor',
  // CDP 는 IPC 를 많이 친다 — 홍수 방지가 명령을 떨어뜨린다
  '--disable-ipc-flooding-protection',
  // 크래시 리포터·breakpad 는 컨테이너에서 쓰기 실패로 경고를 낸다
  '--disable-breakpad',
  '--disable-crash-reporter',
  // /dev/shm 이 작은 컨테이너에서 렌더러가 죽는다
  '--disable-dev-shm-usage',
  // 사람에게 묻는 UI 는 전부 끈다 — 인포바·검색엔진 선택·재전송 확인·팝업 차단.
  // 팝업 차단은 페이지가 여는 창을 그대로 보려고 끈다
  '--disable-infobars',
  '--disable-search-engine-choice-screen',
  '--disable-prompt-on-repost',
  '--disable-popup-blocking',
  // macOS 키체인·리눅스 비밀 저장소 프롬프트가 기동을 막는다
  '--password-store=basic',
  '--use-mock-keychain',
  // 스크린샷 재현성 — 지문(pageFingerprint)이 색 공간에 흔들리면 안 된다
  '--force-color-profile=srgb',
  // 커밋 전 입력 허용 — 첫 명령이 페이지 커밋을 기다리지 않게
  '--allow-pre-commit-input',
  // 번역 제안(프로필 Preferences 로도 막는다 — 둘 다 필요했다, 실측) · Client Hints 프레임 ·
  // 미디어 라우터 · 최적화 힌트 · 프로세스 모델 실험. puppeteer 와 같은 목록이고 같은 이유다
  '--disable-features=Translate,AcceptCHFrame,MediaRouter,OptimizationHints,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes',
  // 백그라운드 페이지를 가진 내장 확장 — 확장을 켠 세션에서도 이것은 잡음이다
  '--disable-component-extensions-with-background-pages',
];

/** headless 에서만 — 스크롤바가 스크린샷에 들어가고, 소리는 낼 곳이 없다 */
export const HEADLESS_ARGS: readonly string[] = ['--headless=new', '--hide-scrollbars', '--mute-audio'];

export interface ChromeArgsSpec {
  /** 대장에 적히는, tirno 가 명시적으로 넘긴 인자 (`--remote-debugging-port` · `--window-size` · 사용자 `--` 뒤) */
  declared: readonly string[];
  userDataDir: string;
  headless: boolean;
  /**
   * 확장을 돌린다. 기본은 끔 — 확장은 페이지가 하는 일을 바꾸고 이 도구는 있는 그대로
   * 관측한다. 켜려면 `--disable-extensions` 를 **처음부터 빼야** 한다 (#113).
   */
  extensions: boolean;
  /** 마지막 positional — 크롬이 그 URL 을 연다. 없으면 about:blank */
  bootUrl?: string;
}

/** 순수 함수 — 크롬은 같은 플래그가 겹치면 **마지막** 값을 쓰므로 선언이 기준 뒤에 온다. */
export function buildChromeArgs(spec: ChromeArgsSpec): string[] {
  return [
    ...BASELINE_ARGS,
    ...(spec.extensions ? [] : ['--disable-extensions']),
    ...(spec.headless ? HEADLESS_ARGS : []),
    `--user-data-dir=${spec.userDataDir}`,
    ...spec.declared,
    spec.bootUrl ?? 'about:blank',
  ];
}

export interface SpawnedChrome {
  process: ChildProcess;
  pid: number;
  /** 지금까지 받은 stderr — 기동 실패의 원인은 여기 적혀 있다 */
  stderr(): string;
  /** 죽었으면 종료 코드, 아니면 null */
  exitCode(): number | null;
}

const STDERR_KEEP = 64 * 1024;

/**
 * 띄운다. stdio 는 파이프로 받되 곧 unref 한다 — Chrome 이 CLI 를 넘겨 살아야 하고,
 * 파이프가 이벤트 루프를 붙들면 명령이 끝나지 않는다(그것을 죽이면 Chrome 도 같이 죽는다).
 * 읽는 쪽을 destroy 하지 않고 unref 만 하는 이유: 닫힌 파이프에 쓰는 Chrome 은 EPIPE 를 받는다.
 */
export function spawnChrome(executablePath: string, args: string[]): SpawnedChrome {
  const child = spawn(executablePath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  if (!child.pid) throw new Error(`Failed to launch the browser process: spawn returned no pid for ${executablePath}`);
  let stderr = '';
  let exit: number | null = null;
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });
  child.stdout!.resume();
  child.on('exit', (code) => { exit = code ?? -1; });
  child.on('error', (e) => { stderr += `\n${e.message}`; exit = -1; });
  return {
    process: child,
    pid: child.pid,
    stderr: () => stderr,
    exitCode: () => exit,
  };
}

export interface DevToolsEndpoint {
  port: number;
  wsEndpoint: string;
}

/**
 * DevTools 가 듣기 시작할 때까지 기다린다.
 *
 * port 0 이면 Chrome 이 고른 포트가 `DevToolsActivePort` 에 적힌다 — 그 파일이 앵커
 * MCP 가 읽는 것과 같은 파일이므로 그것을 정본으로 쓴다. 고정 포트는 그 파일을 안 쓰므로
 * `/json/version` 을 두드린다. 그 전에 프로세스가 죽으면 stderr 를 실어 던진다 —
 * 샌드박스 실패의 조언이 거기 있다(launch-hint 가 그것을 tirno 문법으로 옮긴다).
 */
export async function waitForDevTools(
  chrome: SpawnedChrome, userDataDir: string, requestedPort: number, timeoutMs = 15000,
): Promise<DevToolsEndpoint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (chrome.exitCode() !== null) {
      throw new Error(`Failed to launch the browser process (exit ${chrome.exitCode()})\n${chrome.stderr()}`.trimEnd());
    }
    if (requestedPort === 0) {
      const active = readActivePort(userDataDir);
      if (active) return { port: active.port, wsEndpoint: active.wsEndpoint };
    } else {
      const ws = await browserWsEndpoint(requestedPort).catch(() => null);
      if (ws) return { port: requestedPort, wsEndpoint: ws };
    }
    if (Date.now() >= deadline) {
      throw new Error(`Chrome (pid ${chrome.pid}) did not open its DevTools endpoint within ${timeoutMs}ms\n${chrome.stderr()}`.trimEnd());
    }
    await new Promise(r => setTimeout(r, 50));
  }
}

/** `http://127.0.0.1:<port>/json/version` 의 `webSocketDebuggerUrl` */
export async function browserWsEndpoint(port: number, host = '127.0.0.1'): Promise<string> {
  const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`/json/version answered ${res.status}`);
  const body = await res.json() as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error('/json/version has no webSocketDebuggerUrl');
  return body.webSocketDebuggerUrl;
}

/** 파이프와 프로세스 핸들을 놓는다 — 이 CLI 가 끝나도 Chrome 은 산다 */
export function releaseChrome(chrome: SpawnedChrome): void {
  for (const stream of [chrome.process.stdin, chrome.process.stdout, chrome.process.stderr]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }
  chrome.process.unref();
}
