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
 * 진짜 클릭이 포커스를 옮기는 것을 흉내 낸다 — **두 방향 모두.**
 *
 * `this.click()` 은 합성 클릭이라 포커스를 건드리지 않는다. 그래서 두 가지가 어긋난다.
 *
 * 1. 앞에서 채운 필드가 블러되지 않아, 블러에서만 나오는 `change` 가 끝내 안 나온다.
 *    값을 `change` 에서 커밋하는 폼(ExtJS 계열)은 DOM 에 값이 보이는데도 빈 값을
 *    제출한다 (#166).
 * 2. **누른 요소가 포커스를 받지 못한다.** 그래서 `click @ref` 로 입력칸을 누른 뒤
 *    `type` 을 치면 글자가 아무 데도 안 들어간다 — 셀렉터로 누르면(진짜 마우스라)
 *    들어가므로, 같은 명령이 대상 표기에 따라 갈린다.
 *
 * 진짜 클릭은 mousedown 에서 포커스를 옮긴다 — **click 핸들러가 돌기 전이다.** 그래서
 * 순서가 블러 → 포커스 → 클릭이어야 한다. 핸들러가 `document.activeElement` 를 읽으면
 * 이미 누른 요소여야 한다.
 *
 * 포커스를 못 받는 요소(평범한 div)에서 `focus()` 는 아무 일도 안 한다. 진짜 클릭도
 * 그때는 포커스를 비우기만 하므로, 블러만 남는 것이 맞는 결과다.
 *
 * shadow root 안에 포커스가 있으면 `activeElement` 는 호스트를 준다. 커밋해야 할 것은
 * 안쪽 요소이므로 끝까지 내려가서 그것을 블러한다.
 */
const MOVE_FOCUS = `
  let prev = this.ownerDocument.activeElement;
  while (prev && prev.shadowRoot && prev.shadowRoot.activeElement) prev = prev.shadowRoot.activeElement;
  if (prev && prev !== this && typeof prev.blur === "function") prev.blur();
  if (typeof this.focus === "function") this.focus();
`;

export async function clickByRef(page: Page, backendNodeId: number, dbl = false): Promise<void> {
  const { objectId, cdp } = await resolveBackendNode(page, backendNodeId);
  try {
    // scroll into view first to make the click reliable, and move focus the way
    // a real click would — see MOVE_FOCUS.
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(){ this.scrollIntoView({block:"center", inline:"center"});${MOVE_FOCUS}}`,
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
  // 좌표를 셀렉터 자리에 넣으면 브라우저의 `querySelector` SyntaxError 가 그대로
  // 올라와, 무엇이 잘못됐는지 한 번 더 생각해야 한다. 여기서 먼저 알아본다.
  if (asCoords(selector)) {
    throw new Error(`"${selector}" looks like coordinates, but this command takes a CSS selector or @ref. Only click, hover and drag take "x,y".`);
  }
  const el = await findElement(page, selector);
  if (!el) throw new Error(`No element found for selector: ${selector}`);
  return el;
}

/**
 * `"x,y"` 좌표 형태. `click`·`hover`·`drag` 가 셀렉터 대신 받는다.
 *
 * 한 벌만 둔다. 예전에는 명령마다 따로 있었고 받는 것이 서로 달랐다 — `click` 은
 * 음수와 소수를 받는데 `drag` 는 정수만 받았다. `getBoundingClientRect` 가 내는 값이
 * 소수이므로, 좌표를 캐서 넘기는 흐름에서 그 차이가 그대로 드러난다.
 */
export function asCoords(s: string): [number, number] | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
