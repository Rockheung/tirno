// IoU (Intersection over Union) for bbox matching — used to merge a11y refs
// with vision-detected bboxes (e.g. OCR text inside canvas/image).

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function area(b: Bbox): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

export function intersection(a: Bbox, b: Bbox): Bbox {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

export function iou(a: Bbox, b: Bbox): number {
  const inter = area(intersection(a, b));
  if (inter === 0) return 0;
  const union = area(a) + area(b) - inter;
  return union === 0 ? 0 : inter / union;
}

// Returns true if `inner` is mostly contained in `outer` (inner ∩ outer / inner area >= threshold)
export function containedIn(inner: Bbox, outer: Bbox, threshold = 0.8): boolean {
  const innerArea = area(inner);
  if (innerArea === 0) return false;
  return area(intersection(inner, outer)) / innerArea >= threshold;
}
