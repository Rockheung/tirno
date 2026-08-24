import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBody, fileNameFor, flattenResourceTree, matchesFilter, type PageResource } from '../src/cdp/resources.js';
import { select } from '../src/commands/net.js';

// Chrome 은 안 띄운다. 여기서 증명하는 것은 **무엇을 고르고 어떤 이름으로 쓰는가** 이고,
// 그것은 CDP 응답 모양만 있으면 전부 재현된다.

const IG = 'https://scontent-ssn1-1.cdninstagram.com/v/t51.29350-15/12345_n.jpg?stp=dst-jpg&_nc_ht=x&oh=abc&oe=deadbeef';

test('a pattern with no wildcard is a substring match', () => {
  assert.ok(matchesFilter(IG, 'cdninstagram'));
  assert.ok(!matchesFilter(IG, 'fbcdn'));
});

// 서명 URL 은 뒤에 토큰이 길게 붙는다. 패턴이 양끝에서 닫히면 `scontent*.jpg` 가
// 아무것도 못 잡고, 그러면 이 기능을 쓸 수가 없다.
test('wildcards are open at both ends — scontent*.jpg matches a signed URL', () => {
  assert.ok(matchesFilter(IG, 'scontent*.jpg'));
  assert.ok(matchesFilter(IG, '*.jpg?stp*'));
  assert.ok(!matchesFilter(IG, 'scontent*.png'));
});

test('? matches exactly one character', () => {
  assert.ok(matchesFilter('https://x/a1.jpg', '/a?.jpg'));
  assert.ok(!matchesFilter('https://x/a12.jpg', '/a?.jpg'));
});

test('regex metacharacters in a pattern are literal', () => {
  assert.ok(matchesFilter('https://x/a+b.jpg', 'a+b'));
  assert.ok(!matchesFilter('https://x/aaab.jpg', 'a+b'));
});

test('an empty pattern matches everything', () => {
  assert.ok(matchesFilter(IG, ''));
});

// 쿼리는 파일 이름이 아니라 만료 토큰이고, 파일 시스템에 그대로 못 쓰는 문자가 들어 있다.
test('the file name comes from the path, not the query', () => {
  assert.equal(fileNameFor(IG, 'image/jpeg', new Set()), '12345_n.jpg');
});

test('the extension is filled in from the mime type when the path lacks it', () => {
  assert.equal(fileNameFor('https://x/v/abc', 'image/webp', new Set()), 'abc.webp');
  assert.equal(fileNameFor('https://x/v/abc.png', 'image/png', new Set()), 'abc.png');
});

// 13장을 받으려고 부른 명령이 1장을 남기는 것이 이 자리의 조용한 실패 형태다.
test('colliding names are numbered, never overwritten', () => {
  const taken = new Set<string>();
  assert.equal(fileNameFor('https://a/img.jpg', 'image/jpeg', taken), 'img.jpg');
  assert.equal(fileNameFor('https://b/img.jpg', 'image/jpeg', taken), 'img-2.jpg');
  assert.equal(fileNameFor('https://c/img.jpg', 'image/jpeg', taken), 'img-3.jpg');
});

test('a path with no basename still gets a name', () => {
  assert.equal(fileNameFor('https://example.com/', 'text/html', new Set()), 'resource.html');
});

test('separators and dots cannot escape the output directory', () => {
  const name = fileNameFor('https://x/%2e%2e%2f%2e%2e%2fetc/passwd', 'text/html', new Set());
  assert.ok(!name.includes('/'), name);
  assert.ok(!name.startsWith('.'), name);
});

test('iframe resources are listed too — the session received them as well', () => {
  const flat = flattenResourceTree({
    frame: { id: 'main', url: 'https://a/' },
    resources: [{ url: 'https://a/x.js', type: 'Script', mimeType: 'text/javascript', contentSize: 10 }],
    childFrames: [{
      frame: { id: 'sub', url: 'https://b/' },
      resources: [{ url: 'https://b/y.png', type: 'Image', mimeType: 'image/png' }],
    }],
  });
  assert.deepEqual(flat.map(r => [r.url, r.frameId]), [
    ['https://a/x.js', 'main'],
    ['https://b/y.png', 'sub'],
  ]);
  assert.equal(flat[1]!.contentSize, 0, 'a missing contentSize reads as 0, not undefined');
});

// ls 로 확인한 것이 그대로 save 되어야 한다 — 두 명령이 같은 함수로 고르는 이유.
test('type and pattern narrow together, case-insensitively on type', () => {
  const all = flattenResourceTree({
    frame: { id: 'f', url: 'https://a/' },
    resources: [
      { url: 'https://cdn/a.jpg', type: 'Image', mimeType: 'image/jpeg' },
      { url: 'https://cdn/b.png', type: 'Image', mimeType: 'image/png' },
      { url: 'https://cdn/c.js', type: 'Script', mimeType: 'text/javascript' },
    ],
  });
  assert.equal(select(all, undefined, 'image').length, 2);
  assert.equal(select(all, undefined, 'IMAGE').length, 2, 'type is matched case-insensitively');
  assert.equal(select(all, '*.jpg', 'image').length, 1);
  assert.equal(select(all, undefined, undefined).length, 3);
});

// ── 본문을 어디서 가져오나. 1차는 렌더러가 들고 있는 그 응답이고, 밀려났으면 브라우저에게
// 다시 받아달라고 한다. 페이지 안의 fetch 로는 안 된다 — 자산은 대개 다른 오리진(CDN)이라
// CORS 가 막는다(실측: en.wikipedia.org 문서에서 upload.wikimedia.org 이미지를 fetch 하면
// "Failed to fetch"). 그 폴백이 실제로 도는지를 여기서 본다.

const RESOURCE: PageResource = {
  url: 'https://cdn.example/img.jpg',
  type: 'Image',
  mimeType: 'image/jpeg',
  contentSize: 3,
  frameId: 'F1',
  frameUrl: 'https://example.com/',
};

type Send = (method: string, params?: unknown) => Promise<unknown>;
const fakeCdp = (send: Send) => ({ send } as unknown as Parameters<typeof fetchBody>[0]);

test('the renderer cache is the first source, and it is used verbatim', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff]);
  const body = await fetchBody(fakeCdp(async (method) => {
    assert.equal(method, 'Page.getResourceContent');
    return { content: bytes.toString('base64'), base64Encoded: true };
  }), RESOURCE);
  assert.equal(body.source, 'cache');
  assert.deepEqual(body.bytes, bytes);
});

test('a text resource comes back decoded, not double-encoded', async () => {
  const body = await fetchBody(fakeCdp(async () => ({ content: 'body { }', base64Encoded: false })), RESOURCE);
  assert.equal(body.bytes.toString('utf-8'), 'body { }');
});

test('an evicted resource is re-fetched by the browser, in chunks, and the handle is closed', async () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6]);
  const calls: string[] = [];
  let reads = 0;
  const body = await fetchBody(fakeCdp(async (method, params) => {
    calls.push(method);
    if (method === 'Page.getResourceContent') throw new Error('not in cache');
    if (method === 'Network.loadNetworkResource') {
      // 쿠키를 들고 가야 한다 — 로그인이 필요한 리소스가 이 경로로 온다.
      assert.deepEqual((params as { options: unknown }).options,
        { disableCache: false, includeCredentials: true });
      return { resource: { success: true, httpStatusCode: 200, stream: 'S1' } };
    }
    if (method === 'IO.read') {
      reads++;
      const slice = bytes.subarray((reads - 1) * 3, reads * 3);
      return { data: slice.toString('base64'), base64Encoded: true, eof: reads >= 2 };
    }
    if (method === 'IO.close') return {};
    throw new Error(`unexpected ${method}`);
  }), RESOURCE);

  assert.equal(body.source, 're-fetch');
  assert.deepEqual(body.bytes, bytes, 'chunks must be joined in order');
  assert.ok(calls.includes('IO.close'), 'the stream handle is a browser-side resource; leaking it piles up in the session');
});

test('a re-fetch that the network refused names the reason', async () => {
  await assert.rejects(() => fetchBody(fakeCdp(async (method) => {
    if (method === 'Page.getResourceContent') throw new Error('not in cache');
    return { resource: { success: false, netErrorName: 'net::ERR_ACCESS_DENIED' } };
  }), RESOURCE), /ERR_ACCESS_DENIED/);
});

// 스트림 중간에 실패해도 핸들은 놓아야 한다.
test('a stream that dies mid-read still closes its handle', async () => {
  let closed = false;
  await assert.rejects(() => fetchBody(fakeCdp(async (method) => {
    if (method === 'Page.getResourceContent') throw new Error('not in cache');
    if (method === 'Network.loadNetworkResource') return { resource: { success: true, stream: 'S1' } };
    if (method === 'IO.close') { closed = true; return {}; }
    throw new Error('read failed halfway');
  }), RESOURCE), /read failed halfway/);
  assert.equal(closed, true);
});
