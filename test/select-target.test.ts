import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser } from '../src/cdp/browser.js';
import type { Page } from '../src/cdp/page.js';
import { getActivePage } from '../src/cdp/page-resolver.js';

// `select` 는 앞으로 올리기만 했고 다음 명령은 새 프로세스라, 탭이 둘이면 eval 은
// 늘 "마지막에 연 탭"을 잡았다(#233). 선택은 세션 메타에 남고 connect 가 browser 에
// 실어 준다 — 리졸버는 그것을 먼저 본다.

function fakeBrowser(tabs: Array<{ id: string; url: string }>, preferred?: string): Browser {
  return {
    preferredTargetId: preferred,
    pages: async () => tabs.map(t => ({ targetId: t.id, url: () => t.url })) as unknown as Page[],
  } as unknown as Browser;
}

const tabs = [
  { id: 'aaaa1111', url: 'https://first.example' },
  { id: 'bbbb2222', url: 'https://second.example' },
];

test('선택이 없으면 예전대로 마지막 콘텐츠 탭이다', async () => {
  assert.equal((await getActivePage(fakeBrowser(tabs))).targetId, 'bbbb2222');
});

test('선택된 탭이 열려 있으면 순서와 무관하게 그것이다', async () => {
  assert.equal((await getActivePage(fakeBrowser(tabs, 'aaaa1111'))).targetId, 'aaaa1111');
});

test('선택된 탭이 닫혔으면 막히지 않고 예전 규칙으로 돌아간다', async () => {
  assert.equal((await getActivePage(fakeBrowser(tabs, 'gone0000'))).targetId, 'bbbb2222');
});
