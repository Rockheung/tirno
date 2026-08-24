import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHar, type HarBody } from '../src/output/har.js';
import type { CapturedRequest } from '../src/cdp/network-capture.js';

// HAR 은 이 영역의 유일한 상호운용 포맷이라, 스펙을 어기면 DevTools 가 조용히 항목을
// 안 그린다 — 에러가 아니라 빈 폭포로. 그래서 여기서 보는 것은 "필드가 있다" 가 아니라
// **모르는 값이 -1 인가**와 **time 이 구간의 합인가** 다.

function request(over: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: 0,
    requestId: 'r1',
    url: 'https://example.com/a?q=1&q=2',
    method: 'GET',
    status: 200,
    statusText: 'OK',
    type: 'Document',
    protocol: 'h2',
    requestHeaders: { accept: 'text/html' },
    responseHeaders: { 'content-type': 'text/html' },
    mimeType: 'text/html',
    wallTime: 1_700_000_000,
    timings: { send: 1, wait: 20, receive: 5 },
    encodedDataLength: 1234,
    fromCache: false,
    ...over,
  };
}

interface Har {
  log: {
    version: string;
    creator: { name: string; version: string };
    pages: Array<{ id: string; title: string; startedDateTime: string; pageTimings: Record<string, number> }>;
    entries: Array<{
      pageref: string;
      startedDateTime: string;
      time: number;
      request: Record<string, unknown>;
      response: {
        status: number; bodySize: number; redirectURL: string;
        content: { size: number; mimeType: string; text?: string; encoding?: string };
        headers: Array<{ name: string; value: string }>;
      };
      cache: Record<string, unknown>;
      timings: { send: number; wait: number; receive: number };
    }>;
  };
}

const opts = { pageUrl: 'https://example.com/', pageTitle: 'Example', startedAt: 1_700_000_000_000, version: '0.2.8' };
const har = (rs: CapturedRequest[], bodies?: Map<string, HarBody>) =>
  toHar(rs, { ...opts, ...(bodies ? { bodies } : {}) }) as Har;

test('the envelope is HAR 1.2 with one page every entry refers to', () => {
  const h = har([request()]);
  assert.equal(h.log.version, '1.2');
  assert.equal(h.log.creator.name, 'tirno');
  assert.equal(h.log.pages.length, 1);
  assert.equal(h.log.entries[0]!.pageref, h.log.pages[0]!.id);
});

// time 이 합과 다르면 DevTools 가 그 항목의 폭포를 못 그린다.
test('time is the sum of the known timings', () => {
  const e = har([request()]).log.entries[0]!;
  assert.equal(e.time, 26);
});

// 0 은 "즉시 끝났다" 는 주장이다. 모른다와 다르다.
test('unknown timings are -1, and then time is -1 too', () => {
  const e = har([request({ timings: { send: -1, wait: -1, receive: -1 } })]).log.entries[0]!;
  assert.equal(e.time, -1);
});

test('a partially known timing sums only what is known', () => {
  const e = har([request({ timings: { send: 2, wait: 8, receive: -1 } })]).log.entries[0]!;
  assert.equal(e.time, 10);
});

test('wallTime becomes an ISO instant, not a relative offset', () => {
  const e = har([request({ wallTime: 1_700_000_000.5 })]).log.entries[0]!;
  assert.equal(e.startedDateTime, '2023-11-14T22:13:20.500Z');
});

test('headers become name/value pairs and the query string is split out', () => {
  const e = har([request()]).log.entries[0]!;
  assert.deepEqual(e.response.headers, [{ name: 'content-type', value: 'text/html' }]);
  assert.deepEqual(e.request.queryString, [{ name: 'q', value: '1' }, { name: 'q', value: '2' }]);
});

// 본문이 없는데 size 0 을 적으면 "빈 응답" 이라는 거짓 주장이 된다.
test('with no body, content.size is -1 and no text is claimed', () => {
  const e = har([request()]).log.entries[0]!;
  assert.equal(e.response.content.size, -1);
  assert.equal('text' in e.response.content, false);
});

test('a text body is inlined with its byte length', () => {
  const bodies = new Map([['r1', { text: '가나다', base64: false }]]);
  const e = har([request()], bodies).log.entries[0]!;
  assert.equal(e.response.content.text, '가나다');
  assert.equal(e.response.content.size, 9, 'UTF-8 bytes, not characters');
  assert.equal(e.response.content.encoding, undefined);
});

// 바이너리는 base64 로 싣되, size 는 **디코드된** 크기여야 한다.
test('a binary body declares encoding base64 and the decoded size', () => {
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bodies = new Map([['r1', { text: raw.toString('base64'), base64: true }]]);
  const e = har([request()], bodies).log.entries[0]!;
  assert.equal(e.response.content.encoding, 'base64');
  assert.equal(e.response.content.size, raw.length);
  assert.deepEqual(Buffer.from(e.response.content.text!, 'base64'), raw);
});

test('a POST body rides along as postData', () => {
  const e = har([request({
    method: 'POST',
    postData: '{"a":1}',
    requestHeaders: { 'content-type': 'application/json' },
  })]).log.entries[0]!;
  assert.deepEqual(e.request.postData, { mimeType: 'application/json', text: '{"a":1}' });
  assert.equal(e.request.bodySize, 7);
});

// 전송량 0 을 "빠른 서버" 로 읽으면 안 된다 — 캐시에서 나온 것은 그렇게 적는다.
test('a cache hit is marked in the cache member', () => {
  assert.deepEqual(har([request({ fromCache: true })]).log.entries[0]!.cache, { afterRequest: null });
  assert.deepEqual(har([request()]).log.entries[0]!.cache, {});
});

test('a redirect carries its Location as redirectURL', () => {
  const e = har([request({ status: 302, responseHeaders: { location: 'https://example.com/b' } })]).log.entries[0]!;
  assert.equal(e.response.redirectURL, 'https://example.com/b');
});

test('an unparseable URL yields an empty queryString rather than throwing', () => {
  const e = har([request({ url: 'not a url' })]).log.entries[0]!;
  assert.deepEqual(e.request.queryString, []);
});

test('an empty capture is still a valid HAR', () => {
  const h = har([]);
  assert.deepEqual(h.log.entries, []);
  assert.equal(h.log.pages.length, 1);
});
