import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { clickByRef } from '../src/cdp/dom-actions.js';

// `this.click()` 은 포커스를 옮기지 않는다. 그래서 바로 앞에 채운 필드가 블러되지 않고,
// 블러에서만 나오는 `change` 가 안 나와 프레임워크가 든 값이 빈 채로 제출된다 (#166).
// 여기서 잠그는 것은 **블러가 클릭보다 먼저 간다**는 순서다 — 뒤에 가면 클릭 핸들러가
// 이미 커밋 안 된 모델을 읽은 뒤다.

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

test('ref 클릭은 클릭보다 먼저 이전 포커스를 블러한다', async () => {
  const { page, sent } = fakePage();
  await clickByRef(page, 42);

  assert.equal(sent.length, 2, '두 번의 callFunctionOn 이어야 한다');
  assert.match(sent[0], /scrollIntoView/, '첫 호출이 스크롤이다');
  assert.match(sent[0], /\.blur\(\)/, '첫 호출에서 블러한다');
  assert.match(sent[1], /this\.click\(\)/, '두 번째가 클릭이다');
  assert.doesNotMatch(sent[1], /blur/, '클릭 뒤에 블러하면 늦다');
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
  assert.match(sent[1], /this\.click\(\); this\.click\(\)/);
});
