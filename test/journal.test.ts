import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as journal from '../src/core/journal.js';

// 저널 (#217) — 세션별 jsonl. 여기서 잠그는 것은 읽기 필터(since·last)와 요약 추출.

let tmp: string; let saved: string | undefined;
beforeEach(() => { saved = process.env['TIRNO_DIR']; tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tirno-journal-')); process.env['TIRNO_DIR'] = tmp; });
afterEach(() => { if (saved === undefined) delete process.env['TIRNO_DIR']; else process.env['TIRNO_DIR'] = saved; fs.rmSync(tmp, { recursive: true, force: true }); });

const entry = (t: string, cmd: string, ok = true): journal.JournalEntry => ({ t, cmd, argv: [cmd], ok, ms: 1 });

test('append → read, 순서 그대로', () => {
  journal.append('s', entry('2026-09-16T10:00:00Z', 'nav'));
  journal.append('s', entry('2026-09-16T10:00:01Z', 'click', false));
  assert.deepEqual(journal.read('s').map(e => [e.cmd, e.ok]), [['nav', true], ['click', false]]);
  assert.deepEqual(journal.read('other'), []);
});

test('since 와 last', () => {
  const now = Date.now();
  journal.append('s', entry(new Date(now - 3600_000).toISOString(), 'old'));
  journal.append('s', entry(new Date(now - 10_000).toISOString(), 'recent'));
  journal.append('s', entry(new Date(now - 1_000).toISOString(), 'newest'));
  assert.deepEqual(journal.read('s', { sinceMs: 60_000 }).map(e => e.cmd), ['recent', 'newest']);
  assert.deepEqual(journal.read('s', { last: 1 }).map(e => e.cmd), ['newest']);
});

test('세션 이름의 이상한 글자는 파일명에서 치환된다', () => {
  journal.append('a/b c', entry('2026-09-16T10:00:00Z', 'x'));
  assert.equal(journal.read('a/b c').length, 1);
  assert.ok(fs.existsSync(path.join(tmp, 'journal', 'a_b_c.jsonl')));
});

test('summaryOf — ✓/✗ 줄을 고르고 색 코드를 벗긴다', () => {
  assert.equal(journal.summaryOf('→ note\n\x1b[32m✓\x1b[39m Clicked button "Go"\n  +1 x'), 'Clicked button "Go"');
  assert.equal(journal.summaryOf('just text'), 'just text');
  assert.equal(journal.summaryOf(''), undefined);
});

test('TIRNO_JOURNAL=0 이면 적지 않는다', () => {
  process.env['TIRNO_JOURNAL'] = '0';
  try { journal.append('s', entry('2026-09-16T10:00:00Z', 'x')); assert.deepEqual(journal.read('s'), []); }
  finally { delete process.env['TIRNO_JOURNAL']; }
});
