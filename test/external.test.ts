import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpBaseOf } from '../src/core/external.js';

// `tirno connect` 는 포트 하나부터 /json/version 이 준 ws URL 까지 다 받는다(#236).
// 판정에 쓰는 것은 host:port 뿐이다.

test('포트 · host:port · http · ws 전부 같은 HTTP 베이스가 된다', () => {
  for (const ep of ['9223', '127.0.0.1:9223', 'http://127.0.0.1:9223', 'http://127.0.0.1:9223/json/version', 'ws://127.0.0.1:9223/devtools/browser/abc']) {
    assert.equal(httpBaseOf(ep).origin, 'http://127.0.0.1:9223', ep);
  }
  assert.equal(httpBaseOf('wss://remote.example:443/devtools/browser/x').origin, 'https://remote.example');
});

test('모르는 스킴은 거절한다', () => {
  assert.throws(() => httpBaseOf('ftp://x:1'), /Unsupported endpoint scheme/);
});
