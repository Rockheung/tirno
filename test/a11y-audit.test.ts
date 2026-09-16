import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditAxTree, summarize, sortViolations, RULES, type Violation } from '../src/a11y/audit.js';
import type { AXNode } from '../src/cdp/ax-render.js';

// AX 트리 규칙 (#219). Chrome 은 안 띄운다 — 노드는 Accessibility.getFullAXTree 가 실제로
// 돌려준 모양이다. DOM 쪽 규칙(lang·title·contrast…)과 Tab 걷기는 스모크가 본다.

let seq = 0;
const node = (role: string, name: string, extra: Partial<AXNode> & { level?: number; ignored?: boolean } = {}): AXNode => ({
  nodeId: `n${++seq}`, backendDOMNodeId: 100 + seq,
  role: { value: role }, name: { value: name },
  ignored: extra.ignored ?? false,
  properties: extra.level ? [{ name: 'level', value: { value: extra.level } }] : [],
});

test('이름 없는 인터랙티브는 names, 이름 없는 폼 컨트롤은 labels', () => {
  const vs = auditAxTree([node('button', ''), node('button', 'OK'), node('link', ''), node('textbox', ''), node('checkbox', 'Remember')], null);
  assert.deepEqual(vs.map(v => [v.rule, v.target]), [['names', 'button'], ['names', 'link'], ['labels', 'textbox']]);
  assert.ok(vs.every(v => v.backendNodeId !== undefined), '@N 을 붙일 수 있게 backendNodeId 가 있다');
});

test('alt 없는 이미지 — alt="" 는 트리에서 ignored 라 안 잡힌다', () => {
  const vs = auditAxTree([node('image', ''), node('image', 'hero'), node('image', '', { ignored: true })], null);
  assert.deepEqual(vs.map(v => v.rule), ['alt']);
});

test('헤딩 — 건너뛰면 minor, h1 이 없으면 moderate', () => {
  const vs = auditAxTree([node('heading', 'a', { level: 2 }), node('heading', 'b', { level: 4 }), node('heading', 'c', { level: 3 })], null);
  assert.deepEqual(vs.map(v => [v.rule, v.impact, v.target]), [['headings', 'minor', 'h4'], ['headings', 'moderate', 'document']]);
  const ok = auditAxTree([node('heading', 'a', { level: 1 }), node('heading', 'b', { level: 2 })], null);
  assert.deepEqual(ok, []);
});

test('scope 가 있으면 그 안의 노드만, 문서 단위 규칙(h1 없음)은 안 낸다', () => {
  const a = node('button', ''), b = node('button', '');
  const vs = auditAxTree([a, b, node('heading', 'x', { level: 3 })], new Set([a.backendDOMNodeId!]));
  assert.deepEqual(vs.map(v => v.backendNodeId), [a.backendDOMNodeId]);
});

test('impact 순으로 정렬하고 센다', () => {
  const vs: Violation[] = [
    { rule: 'headings', impact: 'minor', wcag: '', target: '', message: '', fix: '' },
    { rule: 'names', impact: 'serious', wcag: '', target: '', message: '', fix: '' },
    { rule: 'tabindex', impact: 'moderate', wcag: '', target: '', message: '', fix: '' },
  ];
  assert.deepEqual(sortViolations(vs).map(v => v.impact), ['serious', 'moderate', 'minor']);
  assert.deepEqual(summarize(vs), { critical: 0, serious: 1, moderate: 1, minor: 1 });
});

test('규칙 표 — id 는 유일하고 WCAG 참조가 있다', () => {
  assert.equal(new Set(RULES.map(r => r.id)).size, RULES.length);
  for (const r of RULES) assert.match(r.wcag, /^\d\.\d\.\d+$/, r.id);
});
