import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { clickByRef } from '../src/cdp/dom-actions.js';

// `this.click()` 은 포커스를 옮기지 않는다. 그래서 두 방향이 어긋난다.
//
//  1. 앞에 채운 필드가 블러되지 않아 `change` 가 안 나오고, 프레임워크가 든 값이
//     빈 채로 제출된다 (#166).
//  2. 누른 요소가 포커스를 못 받아, `click @ref` 뒤의 `type` 이 아무 데도 안 들어간다.
//     셀렉터로 누르면(진짜 마우스라) 들어가므로 같은 명령이 대상 표기에 따라 갈렸다.
//
// 여기서 잠그는 것은 **블러·포커스가 클릭보다 먼저 간다**는 순서다. 진짜 클릭은
// mousedown 에서 포커스를 옮기므로 click 핸들러가 돌기 전이고, 뒤로 가면 핸들러가
// 커밋 안 된 모델이나 옛 activeElement 를 읽는다.

function fakePage(): { page: Page; sent: string[] } {
  const sent: string[] = [];
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      sent.push(String((params as { functionDeclaration?: string })?.functionDeclaration ?? method));
      return {};
    },
    detach: async () => {},
  };
  const page = { createCDPSession: async () => cdp } as unknown as Page;
  return { page, sent };
}

test('ref 클릭은 클릭보다 먼저 포커스를 옮긴다', async () => {
  const { page, sent } = fakePage();
  await clickByRef(page, 42);

  assert.equal(sent.length, 2, '두 번의 callFunctionOn 이어야 한다');
  assert.match(sent[0], /scrollIntoView/, '첫 호출이 스크롤이다');
  assert.match(sent[0], /\.blur\(\)/, '첫 호출에서 이전 포커스를 뗀다');
  assert.match(sent[0], /this\.focus\(\)/, '첫 호출에서 누른 요소에 포커스를 준다');
  assert.match(sent[1], /this\.click\(\)/, '두 번째가 클릭이다');
  assert.doesNotMatch(sent[1], /blur|focus/, '클릭 뒤에 포커스를 옮기면 늦다');
});

// 블러가 포커스보다 뒤에 가면 방금 준 포커스를 도로 뗀다.
test('블러가 포커스보다 먼저다', async () => {
  const { page, sent } = fakePage();
  await clickByRef(page, 42);
  assert.ok(sent[0].indexOf('.blur()') < sent[0].indexOf('this.focus()'),
    '포커스를 준 뒤에 블러하면 아무것도 포커스되지 않는다');
});

// 셀렉터 경로는 진짜 마우스라 브라우저가 포커스를 준다. @ref 만 손으로 맞춰야 하고,
// 안 맞추면 같은 명령이 대상 표기에 따라 갈린다.
test('포커스는 클릭 대상 자신에게 간다', async () => {
  const { page, sent } = fakePage();
  await clickByRef(page, 42);
  assert.match(sent[0], /typeof this\.focus === "function"/,
    '포커스를 못 받는 요소에서는 아무 일도 없어야 한다');
});

// 같은 요소를 다시 누르는 것은 블러가 아니다 — 진짜 클릭도 그렇다.
test('블러는 클릭 대상 자신은 건드리지 않는다', async () => {
  const { page, sent } = fakePage();
  await clickByRef(page, 42);
  assert.match(sent[0], /prev !== this/, '대상 자신이면 블러하지 않는 가드가 있다');
});

// shadow root 안에 포커스가 있으면 activeElement 는 호스트다. 커밋해야 할 것은 안쪽이다.
test('shadow root 안쪽까지 내려가서 블러한다', async () => {
  const { page, sent } = fakePage();
  await clickByRef(page, 42);
  assert.match(sent[0], /shadowRoot\.activeElement/, 'shadow 안쪽을 찾아 내려간다');
});

test('dbl 도 같은 순서다', async () => {
  const { page, sent } = fakePage();
  await clickByRef(page, 42, true);
  assert.match(sent[0], /\.blur\(\)/);
  assert.match(sent[0], /this\.focus\(\)/);
  assert.match(sent[1], /this\.click\(\); this\.click\(\)/);
});
