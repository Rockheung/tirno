import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootUrlOf, type SessionMetadata } from '../src/core/session-store.js';

const base = { name: 'x', pid: 1, port: 1, wsEndpoint: '', userDataDir: '/tmp/x', createdAt: '', lastAccessedAt: '' } as const;

test('시작 URL 은 장부의 bootUrl 에서 읽는다 — chromeFlags 에는 없다', () => {
  assert.equal(bootUrlOf({ ...base, chromeFlags: ['--window-size=1920,1080'], bootUrl: 'https://a.example/' } as SessionMetadata), 'https://a.example/');
  assert.equal(bootUrlOf({ ...base, chromeFlags: ['--x'] } as SessionMetadata), undefined);
});
