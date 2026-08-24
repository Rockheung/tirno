import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideServedBy, type ServedEvidence } from '../src/commands/sw.js';

// 이 판정은 한 번 틀렸다 (#132): navigateFallback 이 덮은 하위 경로 문서를 origin 이라고
// 답했다. 판정을 페이지 밖으로 꺼낸 이유가 이것이다 — 브라우저를 띄우지 않고 증명할 수
// 있어야 같은 오판이 다시 안 들어온다.

function evidence(over: Partial<ServedEvidence> = {}): ServedEvidence {
  return {
    pathname: '/widget-studio/library/my',
    stamp: null,
    refetchServedBy: null,
    refetchLayer: null,
    cachedPaths: ['/widget-studio', '/assets/index-Ly1_L1hy.js'],
    control: [],
    hasRegistration: true,
    ...over,
  };
}

const proxy = (over: Record<string, unknown> = {}) => ([{
  scope: '/',
  buildId: 'b1',
  layers: [{ name: 'app', mount: '/widget-studio', enabled: true, navigateFallback: '/widget-studio' }],
  ...over,
}]) as ServedEvidence['control'];

test('no worker at all is origin', () => {
  const v = decideServedBy(evidence({ hasRegistration: false }));
  assert.equal(v.verdict, 'origin');
});

// 1차 근거. 재fetch 가 아니라 이 문서가 실제로 받은 그 응답이다.
test('a Server-Timing stamp settles it — even for a navigateFallback path', () => {
  const v = decideServedBy(evidence({ stamp: 'abc123', control: proxy({ stamps: true }) }));
  assert.equal(v.verdict, 'overlay');
  assert.equal(v.by, 'tirno-sw/abc123');
  assert.match(v.evidence, /Server-Timing/);
});

test('the re-fetch header still settles it for an exact-path document', () => {
  const v = decideServedBy(evidence({
    pathname: '/widget-studio',
    refetchServedBy: 'tirno-sw/b1',
    refetchLayer: 'app',
    control: proxy(),
  }));
  assert.equal(v.verdict, 'overlay');
  assert.equal(v.layer, 'app');
});

// 여기가 오판하던 자리다. 옛 워커는 스탬프를 안 찍고, non-navigate 재fetch 는
// fallback 을 못 탄다 — 그러면 **모르는 것이지 origin 이 아니다.**
test('an older build + a path outside Cache Storage is unknown, not origin', () => {
  const v = decideServedBy(evidence({ control: proxy() }));
  assert.equal(v.verdict, 'unknown');
  assert.match(v.evidence, /non-navigate re-fetch/);
});

// 새 빌드는 자기가 낸 문서에 반드시 찍는다. 그래서 **스탬프의 부재가 원본의 증거**다.
test('a stamping build with no stamp on the document is origin', () => {
  const v = decideServedBy(evidence({ control: proxy({ stamps: true }) }));
  assert.equal(v.verdict, 'origin');
  assert.match(v.evidence, /stamps Server-Timing/);
});

test('a worker that is not an sw-proxy is origin — overlay is not even a concept there', () => {
  const v = decideServedBy(evidence({ control: [] }));
  assert.equal(v.verdict, 'origin');
  assert.match(v.evidence, /no tirno sw-proxy/);
});

test('an exact cached path with no header is origin — the re-fetch would have caught it', () => {
  const v = decideServedBy(evidence({ pathname: '/widget-studio', control: proxy() }));
  assert.equal(v.verdict, 'origin');
  assert.match(v.evidence, /Cache Storage/);
});

test('a declared fallback prefix that does not cover this path rules the overlay out', () => {
  const v = decideServedBy(evidence({ pathname: '/other/page', control: proxy() }));
  assert.equal(v.verdict, 'origin');
  assert.match(v.evidence, /no declared navigateFallback prefix/);
});

// sw-template 과 같은 규칙이어야 한다 — 안 그러면 판정이 워커의 실제 행동과 어긋난다.
test('prefix matching is path-segment aware: /app covers /app/x, not /application', () => {
  const under = decideServedBy(evidence({ pathname: '/app/x', control: proxy({ layers: [{ name: 'a', enabled: true, navigateFallback: '/app' }] }) }));
  assert.equal(under.verdict, 'unknown', '/app/x is inside the fallback — cannot be ruled out');

  const beside = decideServedBy(evidence({ pathname: '/application', control: proxy({ layers: [{ name: 'a', enabled: true, navigateFallback: '/app' }] }) }));
  assert.equal(beside.verdict, 'origin', '/application is a different path, not a child of /app');
});

test('a disabled layer declares nothing — it cannot serve, and it cannot rule out either', () => {
  const v = decideServedBy(evidence({
    pathname: '/other/page',
    control: proxy({ layers: [{ name: 'a', enabled: false, navigateFallback: '/widget-studio' }] }),
  }));
  assert.equal(v.verdict, 'unknown');
});
