import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeNavigation } from '../src/cdp/nav-verdict.js';

// 404 도 문서는 커밋된다. 그걸 ✓ exit 0 으로만 내면 호출자는 Not Found 페이지를 정상으로
// 읽는다 (#189). 종료 코드는 호환을 위해 두고, 침묵만 걷는다.

const base = { url: 'https://example.com/x', finalUrl: 'https://example.com/x', elapsed: 10, strict: false };

test('2xx 는 ok', () => {
  assert.equal(judgeNavigation({ ...base, status: 200 }).level, 'ok');
});

test('4xx/5xx 는 기본 warn — exit 0 이되 stderr 에 상태를 말한다', () => {
  const v = judgeNavigation({ ...base, status: 404 });
  assert.equal(v.level, 'warn');
  assert.match(v.note!, /server said 404/);
  assert.match(v.note!, /--strict/);
  assert.equal(judgeNavigation({ ...base, status: 503 }).level, 'warn');
});

test('--strict 면 4xx/5xx 가 fail', () => {
  const v = judgeNavigation({ ...base, status: 404, strict: true });
  assert.equal(v.level, 'fail');
  assert.match(v.note!, /strict/);
});

test('http(s) 인데 응답이 없으면 fail — "0" 은 성공이 아니다', () => {
  const v = judgeNavigation({ ...base, status: 0 });
  assert.equal(v.level, 'fail');
  assert.match(v.line, /no status/);
  assert.match(v.note!, /no response/);
});

test('file:/data:/about: 은 상태 코드가 없는 것이 정상', () => {
  assert.equal(judgeNavigation({ ...base, url: 'file:///tmp/a.html', finalUrl: 'file:///tmp/a.html', status: 0 }).level, 'ok');
  assert.equal(judgeNavigation({ ...base, url: 'data:text/html,hi', finalUrl: 'data:text/html,hi', status: 0 }).level, 'ok');
  assert.equal(judgeNavigation({ ...base, url: 'about:blank', finalUrl: 'about:blank', status: 0 }).level, 'ok');
});

test('chrome-error:// 로 끝났으면 상태와 무관하게 fail', () => {
  const v = judgeNavigation({ ...base, status: 200, finalUrl: 'chrome-error://chromewebdata/' });
  assert.equal(v.level, 'fail');
  assert.match(v.note!, /error page/);
});
