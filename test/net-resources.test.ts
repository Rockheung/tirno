import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileNameFor, flattenResourceTree, matchesFilter } from '../src/cdp/resources.js';
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
