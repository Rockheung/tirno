import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { withResilience, resetSessionState, getSessionCost } from '../src/intelligence/resilience.js';

beforeEach(() => {
  resetSessionState();
});

test('passes through on success', async () => {
  let calls = 0;
  const result = await withResilience(async () => {
    calls++;
    return { value: 'ok', usage: { estimatedCostUsd: 0.001 } };
  });
  assert.equal(result.value, 'ok');
  assert.equal(calls, 1);
  assert.ok(getSessionCost() >= 0.001);
});

test('retries on retryable error then succeeds', async () => {
  let calls = 0;
  const result = await withResilience(
    async () => {
      calls++;
      if (calls < 3) throw new Error('429 rate limit');
      return { value: 'ok' };
    },
    { maxRetries: 5, initialBackoffMs: 1, maxBackoffMs: 5 },
  );
  assert.equal(result.value, 'ok');
  assert.equal(calls, 3);
});

test('does NOT retry non-retryable errors', async () => {
  let calls = 0;
  await assert.rejects(
    withResilience(
      async () => {
        calls++;
        throw new Error('400 bad request');
      },
      { maxRetries: 5, initialBackoffMs: 1 },
    ),
    /400 bad request/,
  );
  assert.equal(calls, 1);
});

test('throws after exhausting retries', async () => {
  let calls = 0;
  await assert.rejects(
    withResilience(
      async () => {
        calls++;
        throw new Error('500 internal');
      },
      { maxRetries: 2, initialBackoffMs: 1, maxBackoffMs: 5 },
    ),
    /500 internal/,
  );
  assert.equal(calls, 3);  // initial + 2 retries
});

test('throws when cost cap reached BEFORE call', async () => {
  // Pre-load cumulative cost
  await withResilience(async () => ({ usage: { estimatedCostUsd: 0.5 } }));
  await assert.rejects(
    withResilience(
      async () => ({ usage: { estimatedCostUsd: 0.001 } }),
      { costCapUsd: 0.4 },
    ),
    /cost cap reached/,
  );
});

test('throws when cost cap reached AFTER call', async () => {
  await assert.rejects(
    withResilience(
      async () => ({ usage: { estimatedCostUsd: 1.0 } }),
      { costCapUsd: 0.5 },
    ),
    /cost cap reached/,
  );
});

test('circuit breaker opens after consecutive failures', async () => {
  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      withResilience(
        async () => { throw new Error('400 not retryable'); },
        { maxRetries: 0, circuitBreakerThreshold: 5 },
      ),
    );
  }
  // 6th call: circuit open
  await assert.rejects(
    withResilience(async () => ({ value: 'ok' })),
    /circuit breaker open/,
  );
});

test('resetSessionState clears cost and circuit', async () => {
  await withResilience(async () => ({ usage: { estimatedCostUsd: 0.1 } }));
  assert.ok(getSessionCost() >= 0.1);
  resetSessionState();
  assert.equal(getSessionCost(), 0);
});

test('onRetry callback fires per attempt', async () => {
  const attempts: number[] = [];
  await withResilience(
    async () => {
      if (attempts.length < 2) throw new Error('429');
      return { value: 'ok' };
    },
    {
      maxRetries: 5,
      initialBackoffMs: 1,
      maxBackoffMs: 5,
      onRetry: (n) => attempts.push(n),
    },
  );
  assert.deepEqual(attempts, [1, 2]);
});
