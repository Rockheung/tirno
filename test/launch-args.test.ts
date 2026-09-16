import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChromeArgs, BASELINE_ARGS, HEADLESS_ARGS } from '../src/cdp/launch.js';

// 기동 인자는 이제 tirno 것이다 (#182). 여기서 잠그는 것은 순서와 스위치다 — 크롬은 같은
// 플래그가 겹치면 마지막 값을 쓰므로 선언이 기준 뒤에 와야 하고, 확장은 처음부터 빼야 켜진다.

const spec = { declared: ['--remote-debugging-port=0', '--window-size=1920,1080'], userDataDir: '/p/x', headless: false, extensions: false };

test('기준 → 확장 스위치 → (headless) → user-data-dir → 선언 → positional 순', () => {
  const a = buildChromeArgs(spec);
  assert.deepEqual(a.slice(0, BASELINE_ARGS.length), [...BASELINE_ARGS]);
  const i = (f: string) => a.findIndex(x => x.startsWith(f));
  assert.ok(i('--disable-extensions') > i('--disable-features'));
  assert.ok(i('--user-data-dir=') > i('--disable-extensions'));
  assert.ok(i('--remote-debugging-port') > i('--user-data-dir='), '선언이 기준 뒤 — 마지막 값이 이긴다');
  assert.equal(a.at(-1), 'about:blank');
});

test('선언이 기준과 같은 플래그를 주면 선언이 뒤에 있어 이긴다', () => {
  const a = buildChromeArgs({ ...spec, declared: ['--disable-features=Nothing'] });
  const all = a.filter(x => x.startsWith('--disable-features='));
  assert.equal(all.at(-1), '--disable-features=Nothing');
});

test('extensions 면 --disable-extensions 가 아예 없다 — 뒤에서 되돌릴 수 없는 플래그다 (#113)', () => {
  assert.ok(buildChromeArgs(spec).includes('--disable-extensions'));
  assert.ok(!buildChromeArgs({ ...spec, extensions: true }).includes('--disable-extensions'));
});

test('headless 는 셋을 더한다', () => {
  const a = buildChromeArgs({ ...spec, headless: true });
  for (const f of HEADLESS_ARGS) assert.ok(a.includes(f), f);
  assert.ok(!buildChromeArgs(spec).some(x => x.startsWith('--headless')));
});

test('bootUrl 이 있으면 그것이 유일한 positional 이다 — about:blank 탭이 따로 안 생긴다', () => {
  const a = buildChromeArgs({ ...spec, bootUrl: 'https://example.com' });
  assert.equal(a.at(-1), 'https://example.com');
  assert.ok(!a.includes('about:blank'));
  // user-data-dir 바로 뒤에 positional 이 오지 않는다 — #123 은 그 자리에서 값이 섞였다
  assert.notEqual(a[a.indexOf(a.find(x => x.startsWith('--user-data-dir='))!) + 1], 'https://example.com');
});

test('puppeteer 가 넣던 --enable-automation 은 없다', () => {
  assert.ok(!buildChromeArgs(spec).includes('--enable-automation'));
});
