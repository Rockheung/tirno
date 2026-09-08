// 창을 앞으로 가져오는 일에는 층이 둘이다.
//
// `Page.bringToFront` 는 **크롬 안에서** 그 탭을 활성 탭으로 만든다. 실측(macOS,
// chrome 152)으로는 이것만으로 `document.hasFocus()` 가 true 가 되고 클립보드가
// 통과했다 — 보내기 전 `false|ERR`, 보낸 뒤 `true|OK`, 그 뒤로 유지된다.
//
// 그것으로 부족한 환경이 보고돼 있다(#174 — `hasFocus()` 가 true 인데도 클립보드가
// 거부). 그때 남는 층은 **OS 의 앱 활성화**이고, 거기서부터는 플랫폼 이야기다.
//
// 그래서 무조건 OS 를 건드리지 않는다. 먼저 크롬 안에서 올려 보고, 그래도 안 되면
// 그때만 OS 로 올린다 — OS 활성화는 사용자가 보던 창을 빼앗는 일이라, 필요하지 않을 때
// 하면 그 자체가 방해다.

import { execFile } from 'node:child_process';

export interface OsFocusResult {
  ok: boolean;
  /** 왜 안 됐는지. 사용자에게 그대로 보여줄 문장이다. */
  reason?: string;
}

/**
 * pid 로 그 앱을 앞으로 올리는 osascript 인자.
 *
 * 번들 이름(`tell application "Google Chrome"`)이 아니라 pid 다. 세션마다 프로필이
 * 다른 크롬이 여럿 떠 있는 것이 이 도구의 기본 상태라, 이름으로는 어느 것인지 갈리지
 * 않는다. pid 는 tirno 가 이미 알고 있다.
 */
export function osActivateArgs(pid: number): string[] {
  return ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`];
}

/** macOS 밖. 조용히 아무것도 안 하되, 안 했다는 것은 말한다. */
export function unsupportedPlatformReason(platform: string): string {
  return `The tab was raised inside chrome, but OS-level window activation is only implemented on macOS (this is ${platform}). `
    + 'If an API still reports the document is not focused, click the browser window once.';
}

/**
 * osascript 가 실패한 이유를 사람 말로.
 *
 * `System Events` 로 다른 프로세스를 조작하려면 **이 터미널에 손쉬운 사용(Accessibility)
 * 권한**이 있어야 한다. 없으면 에러가 -1712(AppleEvent 시간 초과)나 -609(연결 무효)로
 * 나오는데, 둘 다 문구만 봐서는 권한 이야기인 줄 알 수 없다 — 이 머신에서 실제로 그렇게
 * 나왔다. 그래서 번역해 준다.
 */
export function osascriptFailureReason(stderr: string): string {
  const raw = stderr.trim().split('\n').pop() ?? '';
  if (/-1712|-609|not allowed|Not authorized|1743/.test(stderr)) {
    return 'macOS refused the window activation. The terminal running tirno needs Accessibility permission '
      + '(System Settings → Privacy & Security → Accessibility). '
      + `Until then, click the browser window once. (osascript: ${raw})`;
  }
  return `Window activation failed: ${raw}`;
}

/** 실행. macOS 밖이면 아무것도 안 하고 그 사실을 돌려준다. */
export function activateWindow(
  pid: number,
  platform: string = process.platform,
  timeoutMs = 5000,
): Promise<OsFocusResult> {
  if (platform !== 'darwin') {
    return Promise.resolve({ ok: false, reason: unsupportedPlatformReason(platform) });
  }
  return new Promise(resolve => {
    execFile('osascript', osActivateArgs(pid), { timeout: timeoutMs }, (err, _out, stderr) => {
      // osascript 는 실패해도 종료 코드가 0 인 경우가 있다(실측) — stderr 를 함께 본다.
      if (err || /execution error/.test(stderr)) {
        resolve({ ok: false, reason: osascriptFailureReason(stderr || String(err)) });
        return;
      }
      resolve({ ok: true });
    });
  });
}

/**
 * "Document is not focused" 를 다음에 칠 것으로 옮긴다.
 *
 * 이 문구는 `document.hasFocus()` 결과와 정면으로 어긋나 보여서, 다음으로 의심하는
 * 것이 권한이 된다. 실제로는 창이 앞에 없다는 뜻이고, `eval` 은 **일부러** 창을
 * 올리지 않는다 — 페이지를 읽는 것이 사용자가 보던 화면을 빼앗으면 안 되기 때문이다.
 */
export function notFocusedHint(message: string, session?: string): string | null {
  if (!/not focused/i.test(message)) return null;
  return 'Clipboard and other focus-gated APIs need the browser window in front, which is an OS-level '
    + `state — \`permissions grant\` does not cover it. Run \`tirno focus${session ? ` ${session}` : ''}\` first. `
    + '`eval` does not raise the window on its own, so that reading a page never steals your foreground.';
}
