import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, resolveRefs } from '../src/commands/cdp.js';

// `tirno cdp` 는 한 호출이 한 연결이라, 연결에 얹혀 사는 상태가 다음 호출에서 전부
// 무효가 된다 — `objectId` 가 대표다 (#154). `--script` 는 한 연결 위에서 순서대로
// 보내는 자리이고, 여기서 잠그는 것은 **보내기 전에 갈라야 하는 것들**이다.
// 절반쯤 보내다 멈추면 그때까지의 부작용은 남고 되돌릴 수 없다.

test('스크립트는 {method, params} 의 배열이다', () => {
  const steps = parseScript('[{"method":"Runtime.evaluate","params":{"expression":"1"}}]');
  assert.deepEqual(steps, [{ method: 'Runtime.evaluate', params: { expression: '1' } }]);
});

test('params 는 생략할 수 있고 빈 객체가 된다', () => {
  assert.deepEqual(parseScript('[{"method":"Page.reload"}]'), [{ method: 'Page.reload', params: {} }]);
});

test('형태가 틀린 스크립트는 보내기 전에 거절한다', () => {
  assert.throws(() => parseScript('nope'), /not valid JSON/);
  assert.throws(() => parseScript('{"method":"X"}'), /must be a JSON array/);
  assert.throws(() => parseScript('[]'), /empty array/);
  assert.throws(() => parseScript('["Runtime.evaluate"]'), /step 0 is not an object/);
  assert.throws(() => parseScript('[{"params":{}}]'), /step 0 has no "method"/);
  assert.throws(() => parseScript('[{"method":""}]'), /step 0 has no "method"/);
  assert.throws(() => parseScript('[{"method":"X","params":[]}]'), /"params" that is not an object/);
});

// 이슈의 재현이 그대로 이 형태다 — evaluate 가 준 objectId 를 다음 단계가 받는다.
test('$N.경로 가 앞 단계의 결과로 바뀐다', () => {
  const results = [{ result: { objectId: '125438263987084014.394.1' } }];
  assert.deepEqual(
    resolveRefs({ objectId: '$0.result.objectId', depth: 1 }, results, 1),
    { objectId: '125438263987084014.394.1', depth: 1 },
  );
});

// 문자열로 굳히면 nodeId 같은 자리에서 CDP 가 조용히 거절한다.
test('참조된 값은 타입을 지킨다', () => {
  const results = [{ root: { nodeId: 7, backendNodeIds: [3, 4] } }];
  const out = resolveRefs({ nodeId: '$0.root.nodeId', ids: '$0.root.backendNodeIds' }, results, 1);
  assert.deepEqual(out, { nodeId: 7, ids: [3, 4] });
  assert.equal(typeof (out as { nodeId: unknown }).nodeId, 'number');
});

test('중첩된 객체·배열 안까지 바꾼다', () => {
  const results = [{ result: { objectId: 'obj-1' } }];
  assert.deepEqual(
    resolveRefs({ a: { b: ['$0.result.objectId'] } }, results, 1),
    { a: { b: ['obj-1'] } },
  );
});

// 끼워 넣기까지 받으면 "$" 가 들어간 평범한 값이 조용히 뜻이 달라진다.
test('문자열 전체가 참조일 때만 바꾼다', () => {
  const results = [{ result: { objectId: 'obj-1' } }];
  for (const v of ['prefix $0.result.objectId', '$0.result.objectId suffix', '$x.y', '$', 'a$0']) {
    assert.deepEqual(resolveRefs({ v }, results, 1), { v }, `${v} 를 바꿨다`);
  }
});

test('$0 은 앞 단계의 결과 전체다', () => {
  const results = [{ result: { value: 3 } }];
  assert.deepEqual(resolveRefs({ v: '$0' }, results, 1), { v: { result: { value: 3 } } });
});

// 아직 안 돈 단계를 가리키면 undefined 가 조용히 실려 나가는 대신 여기서 멈춘다.
test('뒤 단계나 자기 자신은 참조할 수 없다', () => {
  assert.throws(() => resolveRefs({ v: '$1.result' }, [{}], 1), /step 1 is itself/);
  assert.throws(() => resolveRefs({ v: '$2.result' }, [{}], 1), /step 2 has not run yet/);
});

test('없는 경로는 그 경로를 짚어서 말한다', () => {
  const results = [{ result: { type: 'undefined' } }];
  assert.throws(() => resolveRefs({ v: '$0.result.objectId' }, results, 1),
    /that is undefined in step 0's result/);
  assert.throws(() => resolveRefs({ v: '$0.result.objectId.deep' }, results, 1),
    /has no "result\.objectId\.deep"/);
});
