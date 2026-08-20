import type { CDPSession } from 'puppeteer-core';

export interface ElementInfo {
  selector?: string;
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface ElementAttrs {
  tag: string | null;
  id: string | null;
  testid: string | null;
  ariaLabel: string | null;
  name: string | null;
}

interface BoxModel {
  model: {
    border: number[]; // [x1,y1,x2,y2,x3,y3,x4,y4]
    width: number;
    height: number;
  };
}

interface RemoteObject {
  result: { value?: ElementAttrs | null };
}

const ATTR_SCRIPT = `function(){
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  return {
    tag: el.tagName ? el.tagName.toLowerCase() : null,
    id: el.id || null,
    testid: el.getAttribute('data-testid'),
    ariaLabel: el.getAttribute('aria-label'),
    name: el.getAttribute('name'),
  };
}`;

// Pure decision: stable selector from attribute snapshot.
// Priority: id → data-testid → aria-label → tag[name]. Returns null if none.
export function chooseSelector(attrs: ElementAttrs | null): string | null {
  if (!attrs) return null;
  if (attrs.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(attrs.id)) return '#' + attrs.id;
  if (attrs.testid) return '[data-testid=' + JSON.stringify(attrs.testid) + ']';
  if (attrs.ariaLabel) return '[aria-label=' + JSON.stringify(attrs.ariaLabel) + ']';
  if (attrs.name && attrs.tag) return attrs.tag + '[name=' + JSON.stringify(attrs.name) + ']';
  return null;
}

export async function getElementInfo(cdp: CDPSession, backendNodeId: number): Promise<ElementInfo> {
  const info: ElementInfo = {};

  // bbox via DOM.getBoxModel
  try {
    const box = await cdp.send('DOM.getBoxModel', { backendNodeId }) as BoxModel;
    const b = box.model.border;
    info.bbox = {
      x: Math.round(b[0]),
      y: Math.round(b[1]),
      w: Math.round(box.model.width),
      h: Math.round(box.model.height),
    };
  } catch { /* node may not be visible/rendered */ }

  // attrs via Runtime.callFunctionOn → chooseSelector
  try {
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId }) as { object: { objectId: string } };
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: ATTR_SCRIPT,
      returnByValue: true,
    }) as RemoteObject;
    const selector = chooseSelector(result.result.value ?? null);
    if (selector) info.selector = selector;
    if (resolved.object.objectId) {
      await cdp.send('Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(() => {});
    }
  } catch { /* node may not have a JS object */ }

  return info;
}
