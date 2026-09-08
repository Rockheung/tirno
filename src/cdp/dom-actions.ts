import type { Page, CDPSession, ElementHandle } from 'puppeteer-core';

export interface ResolvedRef {
  objectId: string;
  cdp: CDPSession;
}

export async function resolveBackendNode(page: Page, backendNodeId: number): Promise<ResolvedRef> {
  const cdp = await page.createCDPSession();
  const res = await cdp.send('DOM.resolveNode', { backendNodeId }) as { object: { objectId: string } };
  return { objectId: res.object.objectId, cdp };
}

/**
 * 진짜 클릭이 포커스를 옮기는 것을 흉내 낸다.
 *
 * `this.click()` 은 합성 클릭이라 **포커스를 건드리지 않는다.** 그래서 바로 앞에서 채운
 * 필드가 블러되지 않고, 블러에서만 나오는 `change` 가 끝내 안 나온다. 값을 `change` 에서
 * 커밋하는 폼(ExtJS 계열이 그렇다)은 DOM 에 값이 보이는데도 빈 값을 제출한다 — `fill` 도
 * `click` 도 성공을 보고한 뒤라서 조용히 어긋난다 (#166).
 *
 * shadow root 안에 포커스가 있으면 `activeElement` 는 호스트를 준다. 커밋해야 할 것은
 * 안쪽 요소이므로 끝까지 내려가서 그것을 블러한다.
 */
const BLUR_PREVIOUS = `
  let prev = this.ownerDocument.activeElement;
  while (prev && prev.shadowRoot && prev.shadowRoot.activeElement) prev = prev.shadowRoot.activeElement;
  if (prev && prev !== this && typeof prev.blur === "function") prev.blur();
`;

export async function clickByRef(page: Page, backendNodeId: number, dbl = false): Promise<void> {
  const { objectId, cdp } = await resolveBackendNode(page, backendNodeId);
  try {
    // scroll into view first to make the click reliable, and move focus the way
    // a real click would — see BLUR_PREVIOUS.
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(){ this.scrollIntoView({block:"center", inline:"center"});${BLUR_PREVIOUS}}`,
      awaitPromise: false,
    });
    const fn = dbl
      ? 'function(){ this.click(); this.click(); }'
      : 'function(){ this.click(); }';
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      awaitPromise: true,
    });
  } finally {
    await cdp.detach();
  }
}

export async function fillByRef(page: Page, backendNodeId: number, value: string): Promise<void> {
  const { objectId, cdp } = await resolveBackendNode(page, backendNodeId);
  try {
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({block:"center"}); this.focus(); if (typeof this.select==="function") this.select(); else this.value=""; }',
      awaitPromise: false,
    });
  } finally {
    await cdp.detach();
  }
  // type via the page keyboard so we generate trusted input events
  if (value === '') {
    // Nothing to type, so the selection would just sit there and the old text
    // would survive a command that reported "Filled".
    await page.keyboard.press('Backspace');
    return;
  }
  await page.keyboard.type(value);
}

/** Hover by ref — moves the real pointer to the node's centre, so :hover and
 *  mouseover handlers fire the way they do for a person. */
export async function hoverByRef(page: Page, backendNodeId: number): Promise<void> {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId }) as {
      model: { content: number[] };
    };
    const [x1, y1, , , x3, y3] = model.content;
    await page.mouse.move((x1 + x3) / 2, (y1 + y3) / 2);
  } finally {
    await cdp.detach();
  }
}

// puppeteer 의 다른 쿼리 핸들러들. 이미 붙어 있으면 `pierce/` 를 덧대지 않는다 —
// `pierce/xpath/…` 는 없는 핸들러라 진짜 실패 이유를 가린다.
const HAS_HANDLER = /^(?:pierce|xpath|text|aria)\//;

/**
 * 셀렉터로 요소 하나를 찾는다. light DOM 을 먼저 보고, 없을 때만 열린 shadow root 를
 * 관통한다(puppeteer 의 `pierce/`).
 *
 * 순서가 중요하다. `pierce/` 는 document 도 순회하지만 같은 셀렉터가 양쪽에 있으면
 * **shadow 쪽을 먼저 고른다**(실측). 그래서 `pierce/` 만 쓰면 지금까지 눌리던 요소가
 * 조용히 바뀐다. light DOM 을 먼저 보면 기존 동작은 그대로고, 못 찾을 때만 범위가 넓어진다.
 */
export async function findElement(page: Page, selector: string): Promise<ElementHandle<Element> | null> {
  const direct = await page.$(selector);
  if (direct || HAS_HANDLER.test(selector)) return direct;
  return page.$(`pierce/${selector}`);
}

/** findElement 와 같되, 못 찾으면 puppeteer 와 같은 문구로 던진다. */
export async function requireElement(page: Page, selector: string): Promise<ElementHandle<Element>> {
  const el = await findElement(page, selector);
  if (!el) throw new Error(`No element found for selector: ${selector}`);
  return el;
}
