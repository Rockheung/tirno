import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test__ } from '../src/commands/inspect.js';

const { renderAXTree } = __test__;

// Chrome 은 안 띄운다 — 여기 노드는 `Accessibility.getFullAXTree` 가 실제로 돌려준
// 모양을 그대로 옮긴 것이고, 증명하는 것은 **무엇을 접고 번호를 누구에게 주는가** 다.

interface Node {
  nodeId: string;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  ignored?: boolean;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  properties?: Array<{ name: string; value: { value: unknown } }>;
}

interface NodeOpts {
  name?: string;
  ignored?: boolean;
  children?: Node[];
  backendDOMNodeId?: number | null;
  properties?: Array<{ name: string; value: { value: unknown } }>;
}

let seq = 0;
function node(role: string, opts: NodeOpts = {}): Node {
  const id = `n${++seq}`;
  const children = opts.children ?? [];
  for (const c of children) c.parentId = id;
  const n: Node = { nodeId: id, role: { value: role }, childIds: children.map(c => c.nodeId) };
  if (opts.backendDOMNodeId !== null) n.backendDOMNodeId = opts.backendDOMNodeId ?? ++seq;
  if (opts.name !== undefined) n.name = { value: opts.name };
  if (opts.ignored) n.ignored = true;
  if (opts.properties) n.properties = opts.properties;
  return n;
}

/** 트리를 만들고 nodes 배열(부모→자식 순)로 편다. */
function tree(root: Node, ...rest: Node[]): Node[] {
  return [root, ...rest];
}

function render(nodes: Node[], fold = true) {
  return renderAXTree(nodes as Parameters<typeof renderAXTree>[0], true, fold);
}

test('InlineTextBox is dropped — it repeats the StaticText above it verbatim', () => {
  const inline = node('InlineTextBox', { name: 'Example Domain', backendDOMNodeId: null });
  const text = node('StaticText', { name: 'Example Domain', children: [inline] });
  const root = node('RootWebArea', { name: 'Example', children: [text] });

  const kept = render(tree(root, text, inline));
  assert.deepEqual(kept.lines.map(l => l.slice(4)), [
    'RootWebArea "Example"',
    '  StaticText "Example Domain"',
  ]);
  assert.equal(kept.folded.inlineTextBox, 1);

  const verbose = render(tree(root, text, inline), false);
  assert.equal(verbose.lines.length, 3, '--verbose keeps the duplicate');
});

// 줄바꿈된 텍스트는 InlineTextBox 가 여러 개로 쪼개져서 2배보다 나빠진다.
test('a StaticText split across lines folds all of its boxes', () => {
  const boxes = [
    node('InlineTextBox', { name: 'one', backendDOMNodeId: null }),
    node('InlineTextBox', { name: 'two', backendDOMNodeId: null }),
  ];
  const text = node('StaticText', { name: 'one two', children: boxes });
  const root = node('RootWebArea', { children: [text] });
  const out = render(tree(root, text, ...boxes));
  assert.equal(out.folded.inlineTextBox, 2);
  assert.equal(out.lines.length, 2);
});

test('a chain of bare generics collapses to the thing inside it', () => {
  const link = node('link', { name: 'Log In' });
  let inner = node('generic', { children: [link] });
  const chain = [inner];
  for (let i = 0; i < 5; i++) {
    inner = node('generic', { children: [inner] });
    chain.push(inner);
  }
  const root = node('RootWebArea', { children: [inner] });

  const out = render(tree(root, ...chain.reverse(), link));
  assert.deepEqual(out.lines.map(l => l.slice(4)), ['RootWebArea', '  link "Log In"']);
  assert.equal(out.folded.bareGeneric, 6);
});

// 번호를 먹는 것이 부수적 손해가 아니다 — 의미 있는 요소의 ref 가 뒤로 밀리면
// "@7 을 눌러라" 가 페이지 구조 변화에 더 민감해진다.
test('folded containers do not consume @ref numbers', () => {
  const link = node('link', { name: 'Log In', backendDOMNodeId: 99 });
  const g2 = node('generic', { children: [link] });
  const g1 = node('generic', { children: [g2] });
  const root = node('RootWebArea', { children: [g1] });

  const out = render(tree(root, g1, g2, link));
  assert.deepEqual(Object.keys(out.refs), ['1', '2']);
  assert.equal(out.refs['2']!.backendId, 99, 'the link is @2, not @4');
});

test('a container with two children stays — the grouping is the information', () => {
  const a = node('link', { name: 'a' });
  const b = node('link', { name: 'b' });
  const group = node('generic', { children: [a, b] });
  const root = node('RootWebArea', { children: [group] });

  const out = render(tree(root, group, a, b));
  assert.equal(out.lines.length, 4);
  assert.equal(out.folded.bareGeneric, 0);
});

// a11y 이름이 없는 클릭 가능한 div 는 흔하다. 그것을 접으면 조작 대상이 출력에서
// 사라지는데, 이 명령이 존재하는 이유가 그 대상을 찾는 것이다.
test('a focusable container is kept even with no name', () => {
  const text = node('StaticText', { name: 'x' });
  const clickable = node('generic', {
    children: [text],
    properties: [{ name: 'focusable', value: { value: true } }],
  });
  const root = node('RootWebArea', { children: [clickable] });

  const out = render(tree(root, clickable, text));
  assert.equal(out.folded.bareGeneric, 0);
  assert.ok(out.lines.some(l => l.includes('generic')));
});

test('a named container is never folded', () => {
  const text = node('StaticText', { name: 'x' });
  const named = node('generic', { name: 'sidebar', children: [text] });
  const root = node('RootWebArea', { children: [named] });
  assert.equal(render(tree(root, named, text)).folded.bareGeneric, 0);
});

test('ignored nodes still hand their children up, as before', () => {
  const link = node('link', { name: 'deep' });
  const skipped = node('section', { ignored: true, children: [link] });
  const root = node('RootWebArea', { children: [skipped] });
  const out = render(tree(root, skipped, link));
  assert.deepEqual(out.lines.map(l => l.slice(4)), ['RootWebArea', '  link "deep"']);
});
