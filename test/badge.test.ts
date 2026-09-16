import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBadgeColor, badgeColorHex, badgeInstallScript, BADGE_ID } from '../src/cdp/badge.js';
import { formatTable } from '../src/output/formatter.js';
import chalk from 'chalk';

// 세션 뱃지 — 창 위에 세션 이름. 여기서 잠그는 것은 관측을 더럽히지 않는 조건이 스크립트에
// 실제로 들어 있는가(aria-hidden · fixed · hide/show 손잡이), 색이 읽히는 범위인가, 표가
// 색 코드를 폭으로 세지 않는가다. 붙어서 보이는지는 스모크가 본다.

test('색은 흰 글자가 읽히는 범위(명도 32–50%)에서만 나온다', () => {
  for (const r of [0, 0.25, 0.5, 0.999]) {
    const c = randomBadgeColor(() => r);
    const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(c)!;
    assert.ok(m, c);
    assert.ok(Number(m[3]) >= 32 && Number(m[3]) <= 50, c);
    assert.ok(Number(m[2]) >= 55 && Number(m[2]) <= 80, c);
  }
});

test('hsl → hex — 터미널 점이 창의 뱃지와 같은 색이다', () => {
  assert.equal(badgeColorHex('hsl(0 100% 50%)'), '#ff0000');
  assert.equal(badgeColorHex('hsl(120 100% 25%)'), '#008000');
  assert.equal(badgeColorHex('hsl(240 100% 50%)'), '#0000ff');
  assert.equal(badgeColorHex('nope'), null);
});

test('스크립트는 관측을 더럽히지 않는 조건 셋과 손잡이를 든다', () => {
  const s = badgeInstallScript('my-session', 'hsl(191 68% 38%)');
  assert.match(s, /aria-hidden/, 'a11y 트리에서 빠진다');
  assert.match(s, /position:fixed/, '레이아웃 밖');
  assert.match(s, /hide\(\)/); assert.match(s, /show\(\)/);
  assert.match(s, /window === window\.top/, 'iframe 마다 하나씩 뜨지 않는다');
  assert.match(s, /mode: 'closed'/, '페이지 CSS·스크립트가 못 닿는다');
  assert.match(s, /mousedown/); assert.match(s, /localStorage\.setItem/, '끈 자리가 남는다');
  assert.ok(s.includes(JSON.stringify('my-session')));
  assert.ok(s.includes(BADGE_ID));
  // 이름에 따옴표·백슬래시가 있어도 스크립트가 깨지지 않는다
  assert.doesNotThrow(() => new Function(badgeInstallScript('a"b\\c', 'hsl(1 60% 40%)')));
});

test('formatTable 은 색 코드를 폭으로 세지 않는다', () => {
  const plain = formatTable(['NAME', 'X'], [['w1', '1'], ['longer-name', '2']]);
  const colored = formatTable(['NAME', 'X'], [[`${chalk.hex('#ff0000')('●')} w1`, '1'], ['longer-name', '2']]);
  const stripped = colored.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const widthOf = (t: string) => t.split('\n').map(l => l.length);
  // 색을 벗기면 각 줄의 폭이 같은 표와 같다 — 점 하나("● ")만큼 넓어진 채로
  assert.deepEqual(widthOf(stripped), widthOf(formatTable(['NAME', 'X'], [['● w1', '1'], ['longer-name', '2']])));
  assert.notEqual(plain, colored);
});
