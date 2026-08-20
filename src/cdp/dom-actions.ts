import type { Page, CDPSession } from 'puppeteer-core';

export interface ResolvedRef {
  objectId: string;
  cdp: CDPSession;
}

export async function resolveBackendNode(page: Page, backendNodeId: number): Promise<ResolvedRef> {
  const cdp = await page.createCDPSession();
  const res = await cdp.send('DOM.resolveNode', { backendNodeId }) as { object: { objectId: string } };
  return { objectId: res.object.objectId, cdp };
}

export async function clickByRef(page: Page, backendNodeId: number, dbl = false): Promise<void> {
  const { objectId, cdp } = await resolveBackendNode(page, backendNodeId);
  try {
    // scroll into view first to make the click reliable
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({block:"center", inline:"center"}); }',
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
