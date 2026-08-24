import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as refs from '../src/core/ref-store.js';
import { checkRef } from '../src/cdp/ref-guard.js';

// `@N` 에 세대가 없어서 옛 ref 가 조용히 다른 요소를 눌렀다 — 실패가 에러가 아니라
// 오동작으로 나왔다 (#138). 여기서 증명하는 것은 **거부의 근거**이지 클릭이 아니다.

let tmp: string;
let savedDir: string | undefined;

beforeEach(() => {
  savedDir = process.env['TIRNO_DIR'];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-refs-'));
  process.env['TIRNO_DIR'] = tmp;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env['TIRNO_DIR'];
  else process.env['TIRNO_DIR'] = savedDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function store(over: Partial<refs.RefStore> = {}): refs.RefStore {
  return {
    ...refs.emptyStore(),
    generation: 3,
    url: 'https://example.com/',
    loaderId: 'LOADER1',
    refs: { '7': { backendId: 42, role: 'link', name: 'Learn more' } },
    ...over,
  };
}

test('@N and @vG:N both parse; anything else is not a ref', () => {
  assert.deepEqual(refs.parseRef('@7'), { ref: '7' });
  assert.deepEqual(refs.parseRef('@v3:7'), { ref: '7', generation: 3 });
  assert.equal(refs.parseRef('#btn'), null);
  assert.equal(refs.parseRef('@'), null);
  assert.equal(refs.parseRef('@v3'), null);
});

// 스킬과 문서에 @7 이 잔뜩 적혀 있다. 그것들이 갑자기 틀린 문법이 되는 것은
// 이 이슈가 고치려는 문제와 무관한 손해다.
test('the bare @N form still resolves', () => {
  refs.save('s', store());
  assert.equal(refs.resolveRef('s', '@7'), 42);
  assert.equal(refs.resolveRef('s', '@v3:7'), 42);
});

test('a pinned generation that no longer matches is refused before any CDP call', () => {
  refs.save('s', store({ generation: 5 }));
  assert.throws(() => refs.resolveRef('s', '@v3:7'), /generation 3.*on generation 5/s);
});

test('an unknown ref names the command that would fix it', () => {
  refs.save('s', store());
  assert.throws(() => refs.resolveRef('s', '@99'), /Unknown ref @99.*tirno snapshot/s);
});

// 옛 파일은 `{"7": 123}` 이다. 읽을 수 있어야 하고, 없는 근거로 거부하면 안 된다.
test('a legacy flat ref file migrates instead of failing', () => {
  fs.mkdirSync(path.join(tmp, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'refs', 's.json'), JSON.stringify({ '7': 123 }));
  const loaded = refs.load('s');
  assert.equal(loaded.refs['7']!.backendId, 123);
  assert.equal(loaded.generation, 0);
  assert.equal(loaded.refs['7']!.role, '', 'no identity was recorded back then');
});

test('a corrupt ref file reads as empty rather than throwing', () => {
  fs.mkdirSync(path.join(tmp, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'refs', 's.json'), '{not json');
  assert.deepEqual(refs.load('s').refs, {});
});

// ── 판정. CDP 응답만 흉내내면 브라우저 없이 전부 재현된다.

type Send = (method: string, params?: unknown) => Promise<unknown>;
const fakeCdp = (send: Send) => ({ send } as unknown as Parameters<typeof checkRef>[0]);

function cdpWith({ loaderId, role, name, axThrows }: {
  loaderId?: string; role?: string; name?: string; axThrows?: boolean;
}) {
  return fakeCdp(async (method) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { loaderId } } };
    if (method === 'Accessibility.getPartialAXTree') {
      if (axThrows) throw new Error('No node found');
      return { nodes: [{ backendDOMNodeId: 42, role: { value: role }, name: { value: name } }] };
    }
    throw new Error(`unexpected ${method}`);
  });
}

test('an unchanged document with an unchanged element passes', async () => {
  const v = await checkRef(cdpWith({ loaderId: 'LOADER1', role: 'link', name: 'Learn more' }),
    '@7', store().refs['7']!, store());
  assert.equal(v.ok, true);
});

// loaderId 는 nav 와 reload 를 잡는다 (실측: 둘 다에서 바뀐다).
test('a new loaderId means the document was navigated or reloaded', async () => {
  const v = await checkRef(cdpWith({ loaderId: 'LOADER2', role: 'link', name: 'Learn more' }),
    '@7', store().refs['7']!, store());
  assert.equal(v.ok, false);
  assert.match(v.reason!, /navigated or reloaded.*generation 3/s);
});

// SPA 라우팅은 loaderId 를 안 바꾼다. 그때 무너지는 것은 요소의 identity 다 —
// DOM.describeNode 는 분리된 노드에도 성공하므로 그쪽으로는 못 잡는다(실측).
test('same document, replaced DOM: the element identity collapses and it is refused', async () => {
  const v = await checkRef(cdpWith({ loaderId: 'LOADER1', role: 'none', name: undefined }),
    '@7', store().refs['7']!, store());
  assert.equal(v.ok, false);
  assert.match(v.reason!, /was link "Learn more".*is now \(nothing\)|was link "Learn more".*is now none/s);
});

test('a node that is gone entirely says so', async () => {
  const v = await checkRef(cdpWith({ loaderId: 'LOADER1', axThrows: true }),
    '@7', store().refs['7']!, store());
  assert.equal(v.ok, false);
  assert.match(v.reason!, /gone from the page/);
});

test('a changed label is refused, and the message shows both so it reads as benign', async () => {
  const v = await checkRef(cdpWith({ loaderId: 'LOADER1', role: 'link', name: 'Learn more (2)' }),
    '@7', store().refs['7']!, store());
  assert.equal(v.ok, false);
  assert.match(v.reason!, /was link "Learn more".*is now link "Learn more \(2\)"/s);
});

// 옛 스토어에는 identity 가 없다. 없는 것을 근거로 거부하면, 업그레이드가 곧 고장이 된다.
test('a legacy ref with no recorded identity is not refused for lacking one', async () => {
  const legacy = store({ loaderId: '', refs: { '7': { backendId: 42, role: '', name: '' } } });
  const v = await checkRef(cdpWith({ loaderId: 'ANY', role: 'whatever' }), '@7', legacy.refs['7']!, legacy);
  assert.equal(v.ok, true);
});

// 이름이 비어 있던 요소는 이름으로 판정하지 않는다 — 너무 약한 신호다.
test('an element that had no name is judged on role alone', async () => {
  const nameless = store({ refs: { '7': { backendId: 42, role: 'button', name: '' } } });
  const same = await checkRef(cdpWith({ loaderId: 'LOADER1', role: 'button', name: 'now it has one' }),
    '@7', nameless.refs['7']!, nameless);
  assert.equal(same.ok, true);
  const different = await checkRef(cdpWith({ loaderId: 'LOADER1', role: 'link' }),
    '@7', nameless.refs['7']!, nameless);
  assert.equal(different.ok, false);
});
