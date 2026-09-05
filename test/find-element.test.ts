import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { findElement, requireElement, asCoords } from '../src/cdp/dom-actions.js';

// shadow root 안의 요소는 `document.querySelector` 로 안 잡힌다. puppeteer 의
// `pierce/` 가 그것을 관통하지만, 같은 셀렉터가 light 와 shadow 양쪽에 있으면
// **shadow 쪽을 먼저 고른다**(실측). 그래서 순서가 규약이다 — light 를 먼저 보고,
// 없을 때만 관통한다. 여기서 잠그는 것이 그 순서다.

const ELEMENT = { tag: 'stub' } as unknown as Awaited<ReturnType<Page['$']>>;

function pageWith(found: Set<string>): { page: Page; asked: string[] } {
  const asked: string[] = [];
  const page = {
    $: async (sel: string) => { asked.push(sel); return found.has(sel) ? ELEMENT : null; },
  } as unknown as Page;
  return { page, asked };
}

test('light DOM 에서 찾으면 관통하지 않는다', async () => {
  const { page, asked } = pageWith(new Set(['.dup']));
  assert.equal(await findElement(page, '.dup'), ELEMENT);
  assert.deepEqual(asked, ['.dup']);
});

test('light DOM 에 없으면 pierce 로 다시 찾는다', async () => {
  const { page, asked } = pageWith(new Set(['pierce/#inner']));
  assert.equal(await findElement(page, '#inner'), ELEMENT);
  assert.deepEqual(asked, ['#inner', 'pierce/#inner']);
});

test('양쪽에 없으면 null 이고, 관통까지 시도한 뒤다', async () => {
  const { page, asked } = pageWith(new Set());
  assert.equal(await findElement(page, '#nope'), null);
  assert.deepEqual(asked, ['#nope', 'pierce/#nope']);
});

// `pierce/xpath/…` 는 없는 핸들러라, 덧대면 진짜 실패 이유를 가린다.
test('이미 쿼리 핸들러가 붙은 셀렉터에는 덧대지 않는다', async () => {
  for (const sel of ['pierce/#a', 'xpath//div', 'text/hello', 'aria/Submit']) {
    const { page, asked } = pageWith(new Set());
    assert.equal(await findElement(page, sel), null);
    assert.deepEqual(asked, [sel], `${sel} 에 접두사를 덧댔다`);
  }
});

// 못 찾았을 때의 문구는 puppeteer 가 내던 것과 같아야 한다 — 이 경로를 우리가
// 가로챈 뒤에도 호출자가 보던 메시지가 바뀌지 않는다.
test('requireElement 는 못 찾으면 같은 문구로 던진다', async () => {
  const { page } = pageWith(new Set());
  await assert.rejects(() => requireElement(page, '#nope'),
    { message: 'No element found for selector: #nope' });
});

// 좌표 파서는 한 벌이어야 한다. 예전에는 명령마다 따로였고 `click` 은 소수를 받는데
// `drag` 는 안 받았다 — getBoundingClientRect 가 소수를 내므로 좌표를 캐서 넘기는
// 흐름에서 그 차이가 그대로 드러난다.
test('좌표는 정수·소수·음수와 쉼표 뒤 공백을 받는다', () => {
  assert.deepEqual(asCoords('10,20'), [10, 20]);
  assert.deepEqual(asCoords('10.5, 20.25'), [10.5, 20.25]);
  assert.deepEqual(asCoords('-3,-4'), [-3, -4]);
  assert.deepEqual(asCoords('1749,  233'), [1749, 233]);
});

test('좌표가 아닌 것은 셀렉터로 남는다', () => {
  for (const s of ['.dup', '#a,#b', 'div, span', '10,', ',20', '10,20,30', 'a10,20']) {
    assert.equal(asCoords(s), null, `${s} 를 좌표로 읽었다`);
  }
});

// 좌표를 셀렉터 자리에 넣으면 브라우저의 querySelector SyntaxError 가 그대로 올라와,
// 무엇이 잘못됐는지 한 번 더 생각해야 한다.
test('좌표를 받지 않는 명령은 좌표꼴 입력을 알아본다', async () => {
  const { page, asked } = pageWith(new Set());
  await assert.rejects(() => requireElement(page, '1749,233'),
    /looks like coordinates.*Only click, hover and drag/s);
  assert.deepEqual(asked, [], '좌표꼴인데 셀렉터로 조회했다');
});
