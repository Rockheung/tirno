import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpConnection, CdpError, type Transport } from '../src/cdp/client.js';

// 자체 CDP 클라이언트 (#182). 소켓 없이 전송층을 가짜로 꽂고, 증명하는 것은 프로토콜의
// 규칙이다 — id 로 응답을 짝짓고, sessionId 로 이벤트를 나누고, 오류를 던지고, 연결이
// 닫히면 기다리던 것을 전부 깨운다.

function fakeTransport(): Transport & { sent: Array<Record<string, unknown>>; push(msg: unknown): void; drop(): void } {
  const t = {
    sent: [] as Array<Record<string, unknown>>,
    onmessage: null as ((d: string) => void) | null,
    onclose: null as (() => void) | null,
    send(d: string) { t.sent.push(JSON.parse(d)); },
    close() { t.onclose?.(); },
    push(msg: unknown) { t.onmessage?.(JSON.stringify(msg)); },
    drop() { t.onclose?.(); },
  };
  return t;
}

test('send 는 id 를 붙여 보내고 같은 id 의 result 로 풀린다', async () => {
  const t = fakeTransport();
  const c = new CdpConnection(t);
  const p = c.send('Browser.getVersion');
  assert.deepEqual(t.sent[0], { id: 1, method: 'Browser.getVersion', params: {} });
  t.push({ id: 1, result: { product: 'Chrome/1' } });
  assert.equal((await p).product, 'Chrome/1');
});

test('error 응답은 CdpError 로 던진다 — 어느 메서드였는지 남긴다', async () => {
  const t = fakeTransport();
  const c = new CdpConnection(t);
  const p = c.send('Page.navigate', { url: 'x' });
  t.push({ id: 1, error: { code: -32000, message: 'Cannot navigate to invalid URL' } });
  await assert.rejects(p, (e: CdpError) => e instanceof CdpError && e.method === 'Page.navigate' && /invalid URL/.test(e.message));
});

test('attach 는 flatten 세션을 만들고, 그 세션의 send 에 sessionId 가 붙는다', async () => {
  const t = fakeTransport();
  const c = new CdpConnection(t);
  const attaching = c.attach('T1');
  assert.deepEqual(t.sent[0], { id: 1, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } });
  t.push({ id: 1, result: { sessionId: 'S1' } });
  const s = await attaching;
  const p = s.send('Runtime.evaluate', { expression: '1' });
  assert.equal(t.sent[1].sessionId, 'S1');
  t.push({ id: 2, sessionId: 'S1', result: { result: { type: 'number', value: 1 } } });
  assert.equal((await p).result.value, 1);
});

test('이벤트는 sessionId 로 나뉜다 — 남의 세션 이벤트는 안 받는다', async () => {
  const t = fakeTransport();
  const c = new CdpConnection(t);
  const a = c.sessionFor('A'), b = c.sessionFor('B');
  const gotA: string[] = [], gotB: string[] = [], gotRoot: string[] = [];
  a.on('Page.loadEventFired', () => gotA.push('load'));
  b.on('Page.loadEventFired', () => gotB.push('load'));
  c.on('Target.targetCreated', (p) => gotRoot.push(p.targetInfo.targetId));
  t.push({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'A' });
  t.push({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T9' } } });
  assert.deepEqual(gotA, ['load']);
  assert.deepEqual(gotB, []);
  assert.deepEqual(gotRoot, ['T9']);
});

test('waitFor 는 predicate 가 맞는 이벤트에서 풀리고, 시간이 넘으면 던진다', async () => {
  const t = fakeTransport();
  const c = new CdpConnection(t);
  const s = c.sessionFor('A');
  const w = s.waitFor('Page.frameNavigated', { predicate: (p) => !p.frame.parentId });
  t.push({ method: 'Page.frameNavigated', params: { frame: { id: 'child', parentId: 'main' } }, sessionId: 'A' });
  t.push({ method: 'Page.frameNavigated', params: { frame: { id: 'main' } }, sessionId: 'A' });
  assert.equal((await w).frame.id, 'main');
  await assert.rejects(s.waitFor('Page.loadEventFired', { timeout: 20 }), /timed out after 20ms/);
});

test('연결이 닫히면 기다리던 호출이 전부 깨어나고, 이후 send 는 거절된다', async () => {
  const t = fakeTransport();
  const c = new CdpConnection(t);
  const p1 = c.send('Browser.getVersion');
  const p2 = c.sessionFor('A').send('Runtime.evaluate', { expression: '1' });
  t.drop();
  await assert.rejects(p1, /connection closed while waiting for Browser.getVersion/);
  await assert.rejects(p2, /connection closed/);
  await assert.rejects(c.send('Browser.getVersion'), /connection closed/);
  assert.ok(c.isClosed);
});

test('Target.detachedFromTarget 이 오면 그 세션은 떨어진 것이다', async () => {
  const t = fakeTransport();
  const c = new CdpConnection(t);
  const s = c.sessionFor('A');
  t.push({ method: 'Target.detachedFromTarget', params: { sessionId: 'A' } });
  assert.ok(s.isDetached);
  await assert.rejects(s.send('Runtime.evaluate', { expression: '1' }), /detached/);
});

test('프로토콜이 아닌 메시지는 무시한다 — 연결을 죽이지 않는다', async () => {
  const t = fakeTransport();
  const c = new CdpConnection(t);
  t.push('garbage');
  t.onmessage?.('not json');
  assert.ok(!c.isClosed);
});
