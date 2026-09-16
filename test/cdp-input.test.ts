import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CdpSession } from '../src/cdp/client.js';
import { Keyboard, Mouse } from '../src/cdp/input.js';

// 키보드는 이 리팩터에서 가장 위험한 자리다 (#182) — 규칙을 잘못 옮기면 press·type·fill 이
// 조용히 다른 글자를 낸다. 여기서 잠그는 것은 puppeteer 가 몇 년에 걸쳐 맞춘 규칙 넷:
// 글자가 있으면 keyDown, 없으면 rawKeyDown / 수식키(Shift 제외)가 눌리면 text 는 빈다 /
// 표에 없는 글자는 insertText / 수식키 비트는 마우스에도 실린다.

function fakeSession(): { session: CdpSession; sent: Array<{ method: string; params: Record<string, unknown> }> } {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const session = { send: async (method: string, params: Record<string, unknown>) => { sent.push({ method, params }); return {}; } } as unknown as CdpSession;
  return { session, sent };
}

test('글자 키는 keyDown + text, Enter 는 text "\\r", 화살표는 rawKeyDown', async () => {
  const { session, sent } = fakeSession();
  const kb = new Keyboard(session);
  await kb.press('a');
  assert.equal(sent[0].params.type, 'keyDown');
  assert.equal(sent[0].params.text, 'a');
  assert.equal(sent[0].params.windowsVirtualKeyCode, 65);
  assert.equal(sent[0].params.code, 'KeyA');
  assert.equal(sent[1].params.type, 'keyUp');
  await kb.press('Enter');
  assert.equal(sent[2].params.text, '\r');
  await kb.press('ArrowLeft');
  assert.equal(sent[4].params.type, 'rawKeyDown');
  assert.equal(sent[4].params.text, '');
});

test('Control 이 눌린 채의 a 는 글자가 아니다 — text 가 비고 modifiers 에 2 가 선다', async () => {
  const { session, sent } = fakeSession();
  const kb = new Keyboard(session);
  await kb.down('Control');
  assert.equal(kb.modifiers, 2);
  await kb.press('a');
  const a = sent.find(s => s.params.key === 'a')!;
  assert.equal(a.params.type, 'rawKeyDown');
  assert.equal(a.params.text, '');
  assert.equal(a.params.modifiers, 2);
  await kb.up('Control');
  assert.equal(kb.modifiers, 0);
});

// 표의 `Digit1` 항목이 shiftKey "!" 를 든다 (`'1'` 항목은 안 든다 — puppeteer 와 같다)
test('Shift 는 글자를 살린다 — Shift+Digit1 은 "!"', async () => {
  const { session, sent } = fakeSession();
  const kb = new Keyboard(session);
  await kb.down('Shift');
  await kb.press('Digit1');
  const one = sent.find(s => s.params.code === 'Digit1')!;
  assert.equal(one.params.key, '!');
  assert.equal(one.params.text, '!');
  assert.equal(one.params.modifiers, 8);
});

test('표에 없는 글자(한글)는 insertText 로, 있는 글자는 키 이벤트로', async () => {
  const { session, sent } = fakeSession();
  const kb = new Keyboard(session);
  await kb.type('a한b');
  const methods = sent.map(s => `${s.method}:${s.params.type ?? s.params.text}`);
  assert.deepEqual(methods, [
    'Input.dispatchKeyEvent:keyDown', 'Input.dispatchKeyEvent:keyUp',
    'Input.insertText:한',
    'Input.dispatchKeyEvent:keyDown', 'Input.dispatchKeyEvent:keyUp',
  ]);
});

test('같은 키를 떼지 않고 다시 누르면 autoRepeat', async () => {
  const { session, sent } = fakeSession();
  const kb = new Keyboard(session);
  await kb.down('a');
  await kb.down('a');
  assert.equal(sent[0].params.autoRepeat, false);
  assert.equal(sent[1].params.autoRepeat, true);
});

test('모르는 키는 던진다 — 조용히 아무것도 안 보내지 않는다', async () => {
  const { session } = fakeSession();
  await assert.rejects(new Keyboard(session).press('Bogus'), /Unknown key: "Bogus"/);
});

test('마우스 click 은 move → pressed → released, clickCount 와 수식키 비트를 싣는다', async () => {
  const { session, sent } = fakeSession();
  const kb = new Keyboard(session);
  const mouse = new Mouse(session, kb);
  await kb.down('Meta');
  await mouse.click(10, 20, { count: 2 });
  const m = sent.filter(s => s.method === 'Input.dispatchMouseEvent').map(s => s.params);
  assert.deepEqual(m.map(p => p.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(m[1].clickCount, 2);
  assert.equal(m[1].button, 'left');
  assert.equal(m[1].modifiers, 4);
  assert.deepEqual([m[1].x, m[1].y], [10, 20]);
  assert.deepEqual(mouse.position(), { x: 10, y: 20 });
});

test('steps 만큼 나눠 움직이고 마지막이 목적지다', async () => {
  const { session, sent } = fakeSession();
  const mouse = new Mouse(session, new Keyboard(session));
  await mouse.move(100, 0, { steps: 4 });
  assert.deepEqual(sent.map(s => s.params.x), [25, 50, 75, 100]);
});
