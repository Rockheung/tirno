import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firefoxArgs, parseFirefoxProfile, readFrames } from '../src/core/firefox.js';

const frame = (o: unknown): string => { const s = JSON.stringify(o); return `${Buffer.byteLength(s)}:${s}`; };

test('frames are split on the byte length, not the character count', () => {
  const { frames, rest } = readFrames(Buffer.from(frame({ a: '한글' }) + frame([1, 2])));
  assert.deepEqual(frames, [{ a: '한글' }, [1, 2]]);
  assert.equal(rest.length, 0);
});

test('a partial frame stays in the buffer until the rest arrives', () => {
  const whole = Buffer.from(frame({ a: 1 }));
  const first = readFrames(whole.subarray(0, 4));
  assert.deepEqual(first.frames, []);
  assert.deepEqual(readFrames(Buffer.concat([first.rest, whole.subarray(4)])).frames, [{ a: 1 }]);
});

test('the profile is read back from the command line, spaces included', () => {
  const cmd = firefoxArgs('/Users/a b/profile', true).join(' ');
  assert.equal(parseFirefoxProfile(`/Applications/Firefox.app/Contents/MacOS/firefox ${cmd}`), '/Users/a b/profile');
  assert.equal(parseFirefoxProfile('/usr/bin/chrome --user-data-dir=/x'), null);
});
