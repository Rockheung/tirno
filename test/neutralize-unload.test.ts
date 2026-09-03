import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { NEUTRALIZE_UNLOAD } from '../src/core/chrome-connector.js';

// 이 스크립트는 realm 마다 주입되고, 한 realm 에 두 번 들어가는 일이 실제로 있다
// (iframe realm 을 위젯 수만큼 만드는 페이지 — #155). vm 컨텍스트에 두 번 실행하는
// 것이 그 상황이다: 각 실행이 별도 스크립트라 top-level 선언이 같은 렉시컬 스코프에
// 쌓인다.

interface Sandbox {
  window: Sandbox;
  addEventListener(type: string, listener: unknown, opts?: unknown): unknown;
  __seen: string[];
}

function freshRealm(): Sandbox {
  const seen: string[] = [];
  const sandbox = {
    addEventListener(type: string) { seen.push(type); return true; },
    __seen: seen,
  } as unknown as Sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

test('한 realm 에 두 번 주입해도 던지지 않는다', () => {
  const realm = freshRealm();
  vm.runInContext(NEUTRALIZE_UNLOAD, realm);
  assert.doesNotThrow(() => vm.runInContext(NEUTRALIZE_UNLOAD, realm));
});

test('beforeunload 리스너는 원본에 닿지 않고, 다른 타입은 통과한다', () => {
  const realm = freshRealm();
  vm.runInContext(NEUTRALIZE_UNLOAD, realm);
  realm.window.addEventListener('beforeunload', () => {});
  realm.window.addEventListener('click', () => {});
  assert.deepEqual(realm.__seen, ['click']);
});

// 가드가 없으면 두 번째 주입이 이미 래퍼인 addEventListener 를 다시 감싼다.
// 동작은 같아 보여도 호출마다 프레임이 하나씩 쌓이므로, 같은 함수인지로 잠근다.
test('두 번째 주입은 래퍼를 겹치지 않는다', () => {
  const realm = freshRealm();
  vm.runInContext(NEUTRALIZE_UNLOAD, realm);
  const first = realm.window.addEventListener;
  vm.runInContext(NEUTRALIZE_UNLOAD, realm);
  assert.equal(realm.window.addEventListener, first);
});

test('onbeforeunload 는 읽으면 null, 써도 남지 않는다', () => {
  const realm = freshRealm();
  vm.runInContext(NEUTRALIZE_UNLOAD, realm);
  vm.runInContext("window.onbeforeunload = function () { return 'stay'; };", realm);
  assert.equal(vm.runInContext('window.onbeforeunload', realm), null);
});
