import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeFreshness, describeFreshness, formatAge, DEFAULT_STALE_THRESHOLD } from '../src/core/freshness.js';

// visualFp 는 저장만 되고 비교되지 않았다 (#188). 여기서 잠그는 것은 (1) 비교 못 했으면
// **그렇다고 말한다**, (2) 임계 위는 STALE, (3) 형식이 다르면 비교하지 않는다.

const NOW = new Date('2026-09-16T12:00:00Z');
const FP = 'f'.repeat(64);
const FP_FAR = 'f'.repeat(32) + '0'.repeat(32);     // 128 비트 다름
const FP_NEAR = 'f'.repeat(63) + '0';               // 4 비트 다름

test('나이 표기', () => {
  assert.equal(formatAge(30_000), '<1m');
  assert.equal(formatAge(5 * 60_000), '5m');
  assert.equal(formatAge(3 * 3_600_000), '3h');
  assert.equal(formatAge(72 * 3_600_000), '3d');
});

test('현재 지문이 없으면 not-compared 고 이유가 붙는다', () => {
  const f = judgeFreshness({ capturedAt: '2026-09-13T12:00:00Z', now: NOW, storedFp: FP, reason: 'no session' });
  assert.equal(f.verdict, 'not-compared');
  assert.equal(f.distance, null);
  assert.equal(f.age, '3d');
  assert.match(describeFreshness(f), /distance: n\/a \(not compared — no session\)/);
});

test('가까우면 fresh, 멀면 STALE — 기본 임계는 32', () => {
  assert.equal(DEFAULT_STALE_THRESHOLD, 32);
  const near = judgeFreshness({ capturedAt: NOW.toISOString(), now: NOW, storedFp: FP, currentFp: FP_NEAR });
  assert.equal(near.verdict, 'fresh');
  assert.equal(near.distance, 4);
  assert.match(describeFreshness(near), /distance: 4\/256 \(fresh, threshold 32\)/);
  const far = judgeFreshness({ capturedAt: NOW.toISOString(), now: NOW, storedFp: FP, currentFp: FP_FAR });
  assert.equal(far.verdict, 'stale');
  assert.match(describeFreshness(far), /128\/256 \(STALE/);
});

test('임계는 조정된다', () => {
  assert.equal(judgeFreshness({ capturedAt: NOW.toISOString(), now: NOW, storedFp: FP, currentFp: FP_NEAR, threshold: 2 }).verdict, 'stale');
});

test('형식이 다르면 비교하지 않는다 — 조용히 fresh 로 접지 않는다', () => {
  const f = judgeFreshness({ capturedAt: NOW.toISOString(), now: NOW, storedFp: '0'.repeat(16), currentFp: FP });
  assert.equal(f.verdict, 'not-compared');
  assert.match(f.reason!, /formats differ/);
});
