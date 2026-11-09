import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabHandle } from '../src/core/tab-request.js';

test('탭 ID 는 엔진 식별자의 앞 8자 — Chrome targetId · Firefox UUID · Safari page-…', () => {
  assert.equal(tabHandle('97303167A2B4C6D8E0F1'), '97303167');
  assert.equal(tabHandle('5b3c1d2e-aaaa-bbbb-cccc-dddddddddddd'), '5b3c1d2e');
  assert.equal(tabHandle('page-10183D35-BA97-4F00-0000-000000000000'), '10183d35');
});
