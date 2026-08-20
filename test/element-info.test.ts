import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSelector, type ElementAttrs } from '../src/cdp/element-info.js';

const empty: ElementAttrs = { tag: null, id: null, testid: null, ariaLabel: null, name: null };

test('chooseSelector: null attrs → null', () => {
  assert.equal(chooseSelector(null), null);
});

test('chooseSelector: empty attrs → null', () => {
  assert.equal(chooseSelector(empty), null);
});

test('chooseSelector: id wins (highest priority)', () => {
  const attrs: ElementAttrs = { tag: 'div', id: 'main', testid: 'tid', ariaLabel: 'label', name: 'n' };
  assert.equal(chooseSelector(attrs), '#main');
});

test('chooseSelector: id with hyphen and underscore', () => {
  assert.equal(chooseSelector({ ...empty, id: 'main-content_x' }), '#main-content_x');
});

test('chooseSelector: id starting with digit → reject (CSS rule)', () => {
  // numeric-prefix ids can't be a bare CSS selector; fall through
  assert.equal(chooseSelector({ ...empty, id: '123abc', testid: 't1' }), '[data-testid="t1"]');
});

test('chooseSelector: id with special chars → reject', () => {
  // colons, dots in id break #-form
  assert.equal(chooseSelector({ ...empty, id: 'a.b:c' }), null);
});

test('chooseSelector: data-testid takes second priority', () => {
  const attrs: ElementAttrs = { tag: 'button', id: null, testid: 'submit-btn', ariaLabel: 'l', name: 'n' };
  assert.equal(chooseSelector(attrs), '[data-testid="submit-btn"]');
});

test('chooseSelector: aria-label third priority', () => {
  const attrs: ElementAttrs = { tag: 'button', id: null, testid: null, ariaLabel: '음성 검색', name: 'n' };
  assert.equal(chooseSelector(attrs), '[aria-label="음성 검색"]');
});

test('chooseSelector: tag[name] last priority', () => {
  const attrs: ElementAttrs = { tag: 'input', id: null, testid: null, ariaLabel: null, name: 'q' };
  assert.equal(chooseSelector(attrs), 'input[name="q"]');
});

test('chooseSelector: name without tag → null (need both)', () => {
  const attrs: ElementAttrs = { tag: null, id: null, testid: null, ariaLabel: null, name: 'q' };
  assert.equal(chooseSelector(attrs), null);
});

test('chooseSelector: escapes quotes in attribute values', () => {
  const attrs: ElementAttrs = { tag: null, id: null, testid: 'has "quote"', ariaLabel: null, name: null };
  // JSON.stringify produces "has \"quote\""
  assert.equal(chooseSelector(attrs), '[data-testid="has \\"quote\\""]');
});

test('chooseSelector: aria-label with korean', () => {
  assert.equal(chooseSelector({ ...empty, ariaLabel: '지우기' }), '[aria-label="지우기"]');
});
