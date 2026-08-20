import type { CDPSession } from 'puppeteer-core';

export interface ElementInfo {
  selector?: string;
  bbox?: { x: number; y: number; w: number; h: number };
}

interface BoxModel {
  model: {
    border: number[]; // [x1,y1,x2,y2,x3,y3,x4,y4]
    width: number;
    height: number;
  };
}

interface RemoteObject {
  result: { value?: string };
}

// Best-effort stable selector: id → data-testid → aria-label → name → role
// Returns undefined if no stable attribute.
const SELECTOR_SCRIPT = `function(){
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id)) return '#' + el.id;
  const testid = el.getAttribute('data-testid');
  if (testid) return '[data-testid=' + JSON.stringify(testid) + ']';
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return '[aria-label=' + JSON.stringify(ariaLabel) + ']';
  const name = el.getAttribute('name');
  if (name && el.tagName) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
  return null;
}`;

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

  // selector via Runtime.callFunctionOn
  try {
    const resolved = await cdp.send('DOM.resolveNode', { backendNodeId }) as { object: { objectId: string } };
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: SELECTOR_SCRIPT,
      returnByValue: true,
    }) as RemoteObject;
    if (result.result.value) info.selector = result.result.value;
    if (resolved.object.objectId) {
      await cdp.send('Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(() => {});
    }
  } catch { /* node may not have a JS object */ }

  return info;
}
