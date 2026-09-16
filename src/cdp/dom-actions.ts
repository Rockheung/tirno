import type { Page, ElementHandle } from './page.js';
import type { CdpSession } from './client.js';
import { READ_FIELD_STATE, refuseBeforeTyping, describeMismatch, type FieldState } from './fill-verify.js';
import { HIT_TEST, refuseClick, type HitTest } from './click-target.js';

export interface ResolvedRef {
  objectId: string;
  cdp: CdpSession;
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

export interface ClickOptions {
  /** 출력에 쓸 대상 표기 */
  label: string;
  dbl?: boolean;
  /**
   * 좌표 대신 `this.click()`. 가림·뷰포트를 무시한다 — 뷰포트보다 큰 요소, 보이지 않지만
   * 핸들러는 있는 요소용. 기본은 사람과 같은 쪽(실제 마우스 + 가림 판정) (#183).
   */
  synthetic?: boolean;
}

/**
 * 실제 마우스로 누른다. 진짜 더블클릭처럼 clickCount 1 → 2 두 쌍을 보낸다.
 * mousedown 이 포커스를 옮기므로 MOVE_FOCUS 가 필요 없다 — 그것은 합성 경로의 보정이다.
 */
async function mouseClickAt(page: Page, x: number, y: number, dbl?: boolean): Promise<void> {
  await page.mouse.click(x, y, { count: 1 });
  if (dbl) await page.mouse.click(x, y, { count: 2 });
}

/**
 * 합성 클릭. 포커스는 직접 옮긴다 — `this.click()` 은 안 옮기고, 그 어긋남이 #166 이었다.
 * 순서는 블러 → 포커스 → 클릭이어야 한다(MOVE_FOCUS 주석).
 */
async function syntheticClick(cdp: CdpSession, objectId: string, dbl?: boolean): Promise<void> {
  // 텍스트 노드(StaticText ref)에는 click() 이 없다 — 부모 요소로 올라간다
  const asElement = 'const el = this.nodeType === 1 ? this : this.parentElement; if (!el) throw new Error("not an element");';
  await callOrThrow(cdp, objectId, `function(){ ${asElement} el.scrollIntoView({block:"center", inline:"center"}); (function(){${MOVE_FOCUS}}).call(el); }`);
  await callOrThrow(cdp, objectId, `function(){ ${asElement} el.click(); ${dbl ? 'el.click();' : ''} }`, true);
}

/**
 * `Runtime.callFunctionOn` 은 페이지가 던진 예외를 **돌려준다** — `exceptionDetails` 로.
 * 안 보면 `this.click is not a function` 이 성공으로 지나간다.
 */
async function callOrThrow(cdp: CdpSession, objectId: string, functionDeclaration: string, awaitPromise = false): Promise<unknown> {
  const res = await cdp.send('Runtime.callFunctionOn', {
    objectId, functionDeclaration, awaitPromise, returnByValue: true,
  }) as { result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`page threw during click: ${d.exception?.description?.split('\n')[0] ?? d.text ?? 'unknown error'}`);
  }
  return res.result.value;
}

export async function clickByRef(
  page: Page, backendNodeId: number, opts: ClickOptions = { label: '@ref' },
): Promise<void> {
  const { objectId, cdp } = await resolveBackendNode(page, backendNodeId);
  try {
    if (opts.synthetic) {
      await syntheticClick(cdp, objectId, opts.dbl);
      return;
    }
    const h = await callOrThrow(cdp, objectId, HIT_TEST) as HitTest;
    const refusal = refuseClick(opts.label, h);
    if (refusal) throw new Error(refusal);
    await mouseClickAt(page, h.x, h.y, opts.dbl);
  } finally {
    await cdp.detach();
  }
}

/** 셀렉터 경로. ref 경로와 같은 계약 — 가림 판정 뒤 실제 마우스. */
export async function clickElement(page: Page, el: ElementHandle, opts: ClickOptions): Promise<void> {
  if (opts.synthetic) {
    await el.evaluate(new Function('el', `el.scrollIntoView({block:"center", inline:"center"}); (function(){${MOVE_FOCUS}}).call(el); el.click(); ${opts.dbl ? 'el.click();' : ''}`) as never);
    return;
  }
  // ElementHandle.evaluate 는 요소를 첫 인자로 넘긴다 — `this` 가 아니다.
  const h = await el.evaluate(new Function('el', `return (${HIT_TEST}).call(el)`) as never) as HitTest;
  const refusal = refuseClick(opts.label, h);
  if (refusal) throw new Error(refusal);
  await mouseClickAt(page, h.x, h.y, opts.dbl);
}

export interface FillOptions {
  /** 출력에 쓸 대상 표기 — `@39` 또는 셀렉터 */
  label: string;
  /** 타이핑 뒤 값을 되읽어 다르면 던진다. 기본 켬 (#184) */
  verify?: boolean;
  /** `--value-stdin` — 불일치 메시지에 값 대신 길이만 싣는다 */
  hideValue?: boolean;
}

/** 요소의 현재 상태를 읽는다. `objectId` 는 같은 세션에서 얻은 것이어야 한다. */
async function readFieldState(cdp: CdpSession, objectId: string): Promise<FieldState> {
  const res = await cdp.send('Runtime.callFunctionOn', {
    objectId, functionDeclaration: READ_FIELD_STATE, returnByValue: true,
  }) as { result: { value: FieldState } };
  return res.result.value;
}

/**
 * 채우기 전후로 요소를 읽는다 — 전에는 키가 버려질 요소(disabled·readonly)를 거절하고,
 * 후에는 값이 실제로 들어갔는지 본다. 어느 쪽이든 어긋나면 던진다: `keyboard.type` 은
 * 그 넷(readonly · preventDefault · maxlength · 포커스 이동) 전부를 예외 없이 끝내므로,
 * 여기서 안 보면 "Filled" 가 거짓이 된다 (#184).
 */
export async function fillByRef(
  page: Page, backendNodeId: number, value: string, opts: FillOptions = { label: '@ref' },
): Promise<void> {
  const verify = opts.verify !== false;
  const { objectId, cdp } = await resolveBackendNode(page, backendNodeId);
  try {
    if (verify) {
      const refusal = refuseBeforeTyping(opts.label, await readFieldState(cdp, objectId));
      if (refusal) throw new Error(refusal);
    }
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({block:"center"}); this.focus(); if (typeof this.select==="function") this.select(); else this.value=""; }',
      awaitPromise: false,
    });
    // type via the page keyboard so we generate trusted input events
    if (value === '') {
      // Nothing to type, so the selection would just sit there and the old text
      // would survive a command that reported "Filled".
      await page.keyboard.press('Backspace');
    } else {
      await page.keyboard.type(value);
    }
    if (verify) {
      const mismatch = describeMismatch(opts.label, value, await readFieldState(cdp, objectId), opts.hideValue);
      if (mismatch) throw new Error(mismatch);
    }
  } finally {
    await cdp.detach();
  }
}

/**
 * 셀렉터 경로의 fill. ref 경로와 같은 계약 — 전에 거절, 후에 되읽기. 타이핑은 트리플
 * 클릭으로 전체 선택한 뒤 `type` 한다 (진짜 마우스·키보드).
 */
export async function fillElement(
  page: Page, el: ElementHandle, value: string, opts: FillOptions,
): Promise<void> {
  const verify = opts.verify !== false;
  // ElementHandle.evaluate 는 요소를 첫 인자로 넘긴다 — `this` 가 아니다.
  const read = () => el.evaluate(new Function('el', `return (${READ_FIELD_STATE}).call(el)`) as never) as Promise<FieldState>;
  if (verify) {
    const refusal = refuseBeforeTyping(opts.label, await read());
    if (refusal) throw new Error(refusal);
  }
  await el.click({ count: 3 });
  if (value === '') await page.keyboard.press('Backspace');
  else await el.type(value);
  if (verify) {
    const mismatch = describeMismatch(opts.label, value, await read(), opts.hideValue);
    if (mismatch) throw new Error(mismatch);
  }
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

// 셀렉터 접두사(`pierce/` 등). 이미 붙어 있으면 `pierce/` 를 덧대지 않는다 —
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
export async function findElement(page: Page, selector: string): Promise<ElementHandle | null> {
  const direct = await page.$(selector);
  if (direct || HAS_HANDLER.test(selector)) return direct;
  return page.$(`pierce/${selector}`);
}

/** findElement 와 같되, 못 찾으면 puppeteer 와 같은 문구로 던진다. */
export async function requireElement(page: Page, selector: string): Promise<ElementHandle> {
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
