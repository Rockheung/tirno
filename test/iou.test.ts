import { test } from 'node:test';
import assert from 'node:assert/strict';
import { area, intersection, iou, containedIn, type Bbox } from '../src/cdp/iou.js';

const box = (x: number, y: number, w: number, h: number): Bbox => ({ x, y, w, h });

test('area: simple', () => {
  assert.equal(area(box(0, 0, 10, 20)), 200);
});

test('area: zero or negative dimensions', () => {
  assert.equal(area(box(0, 0, 0, 10)), 0);
  assert.equal(area(box(0, 0, 10, 0)), 0);
  assert.equal(area(box(0, 0, -5, 10)), 0);
});

test('intersection: full overlap', () => {
  const a = box(0, 0, 10, 10);
  const b = box(0, 0, 10, 10);
  assert.deepEqual(intersection(a, b), { x: 0, y: 0, w: 10, h: 10 });
});

test('intersection: partial overlap', () => {
  const a = box(0, 0, 10, 10);
  const b = box(5, 5, 10, 10);
  assert.deepEqual(intersection(a, b), { x: 5, y: 5, w: 5, h: 5 });
});

test('intersection: no overlap → zero area', () => {
  const a = box(0, 0, 10, 10);
  const b = box(20, 20, 10, 10);
  const inter = intersection(a, b);
  assert.equal(area(inter), 0);
});

test('intersection: edge touching → zero area', () => {
  const a = box(0, 0, 10, 10);
  const b = box(10, 0, 10, 10);
  assert.equal(area(intersection(a, b)), 0);
});

test('iou: identical boxes → 1', () => {
  const a = box(0, 0, 10, 10);
  assert.equal(iou(a, a), 1);
});

test('iou: no overlap → 0', () => {
  assert.equal(iou(box(0, 0, 10, 10), box(20, 20, 10, 10)), 0);
});

test('iou: half overlap', () => {
  // a=10x10, b=10x10 shifted 5 right and 5 down → inter 5x5=25, union 100+100-25=175
  const a = box(0, 0, 10, 10);
  const b = box(5, 5, 10, 10);
  assert.equal(iou(a, b), 25 / 175);
});

test('iou: contained box', () => {
  // a=20x20=400, b=10x10=100 inside a → inter=100, union=400, iou=0.25
  const a = box(0, 0, 20, 20);
  const b = box(5, 5, 10, 10);
  assert.equal(iou(a, b), 100 / 400);
});

test('containedIn: fully inside', () => {
  const inner = box(5, 5, 5, 5);
  const outer = box(0, 0, 20, 20);
  assert.equal(containedIn(inner, outer), true);
});

test('containedIn: half outside (below 0.8 threshold)', () => {
  const inner = box(8, 0, 4, 4);   // 16px²
  const outer = box(0, 0, 10, 10); // contains (8,0)-(10,4) = 2x4 = 8px²
  // 8/16 = 0.5 < 0.8
  assert.equal(containedIn(inner, outer, 0.8), false);
});

test('containedIn: zero-area inner → false', () => {
  assert.equal(containedIn(box(0, 0, 0, 0), box(0, 0, 10, 10)), false);
});

test('containedIn: custom threshold', () => {
  const inner = box(0, 0, 10, 10); // 100
  const outer = box(0, 0, 7, 10);  // inter = 7x10 = 70
  // 70/100 = 0.7
  assert.equal(containedIn(inner, outer, 0.7), true);
  assert.equal(containedIn(inner, outer, 0.71), false);
});
