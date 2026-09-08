import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  osActivateArgs, unsupportedPlatformReason, osascriptFailureReason,
  notFocusedHint, activateWindow,
} from '../src/core/os-focus.js';

// 클립보드는 **OS 레벨 창 활성화**를 본다. 그런데 실패 문구가
// `Document is not focused` 라, `document.hasFocus()` 결과와 어긋나 보인다 —
// 그래서 다음으로 의심하는 것이 권한이 되고 진단이 샌다 (#174).

// 세션마다 프로필이 다른 크롬이 여럿 떠 있는 것이 이 도구의 기본 상태다.
// 번들 이름으로 고르면 어느 것인지 갈리지 않는다.
test('창 활성화는 앱 이름이 아니라 pid 로 고른다', () => {
  const args = osActivateArgs(4321);
  assert.equal(args[0], '-e');
  assert.match(args[1], /unix id is 4321/);
  assert.doesNotMatch(args[1], /Google Chrome/, '이름으로 고르면 세션이 여럿일 때 갈리지 않는다');
});

test('macOS 밖에서는 아무것도 안 하고, 안 했다고 말한다', async () => {
  const res = await activateWindow(1, 'linux');
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /only implemented on macOS \(this is linux\)/);
  // 막다른 골목으로 두지 않는다 — 손으로 할 수 있는 것을 알려준다.
  assert.match(res.reason ?? '', /click the browser window/i);
  assert.equal(unsupportedPlatformReason('win32').includes('win32'), true);
});

// -1712·-609 는 문구만 봐서는 권한 이야기인 줄 알 수 없다. 이 머신에서 실제로 그렇게
// 나왔고, 사용자가 손쉬운 사용 권한을 준 뒤에 통과했다.
test('권한 때문에 막힌 것은 권한 이야기로 옮긴다', () => {
  for (const code of ['-1712', '-609', '(1743)']) {
    const reason = osascriptFailureReason(`execution error: System Events ... ${code}`);
    assert.match(reason, /Accessibility/, `${code} 를 권한으로 안 읽었다`);
    assert.match(reason, /System Settings/, '어디서 켜는지가 없다');
  }
});

test('권한과 무관한 실패는 그대로 옮긴다', () => {
  const reason = osascriptFailureReason('execution error: something else entirely (-42)');
  assert.doesNotMatch(reason, /Accessibility/, '아무 실패나 권한 탓으로 돌리면 진단이 또 샌다');
  assert.match(reason, /something else entirely/);
});

// 이 안내가 이 이슈의 본체다 — 문구가 가리키는 곳이 틀려서 시간을 썼다.
test('not focused 는 다음에 칠 것으로 옮긴다', () => {
  const hint = notFocusedHint("Failed to execute 'readText' on 'Clipboard': Document is not focused.", 'probe');
  assert.ok(hint);
  assert.match(hint, /tirno focus probe/);
  // 권한이 아니라는 것을 분명히 해야 진단이 그쪽으로 안 샌다.
  assert.match(hint, /permissions grant` does not cover it/);
});

test('세션 이름이 없으면 이름 없는 형태로 안내한다', () => {
  const hint = notFocusedHint('Document is not focused.', undefined);
  assert.match(hint ?? '', /`tirno focus`/);
});

test('다른 에러에는 끼어들지 않는다', () => {
  assert.equal(notFocusedHint('ReferenceError: x is not defined', 'p'), null);
  assert.equal(notFocusedHint('NotAllowedError: Write permission denied.', 'p'), null);
});
