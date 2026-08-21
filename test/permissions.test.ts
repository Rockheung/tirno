import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrigin, validatePermissions, PERMISSION_NAMES } from '../src/cdp/permissions.js';

// Chrome keys grants by origin. Anything narrower that reaches CDP is stored as
// given and then never matches the page, so the trimming happens here where it
// can be proven.
test('normalizeOrigin strips path, query and hash', () => {
  assert.equal(normalizeOrigin('https://imweb.me/login?back_url=x#y'), 'https://imweb.me');
  assert.equal(normalizeOrigin('https://imweb.me'), 'https://imweb.me');
  assert.equal(normalizeOrigin('http://localhost:3000/a/b'), 'http://localhost:3000');
});

test('normalizeOrigin keeps a non-default port', () => {
  assert.equal(normalizeOrigin('https://example.com:8443/x'), 'https://example.com:8443');
});

test('normalizeOrigin rejects a bare host and a non-web scheme', () => {
  assert.throws(() => normalizeOrigin('imweb.me'), /Not a URL/);
  assert.throws(() => normalizeOrigin('file:///tmp/a.html'), /Unsupported scheme/);
});

// A bad name must fail before the apply loop starts — a mid-loop CDP throw
// would leave earlier origins granted while the ledger claims all of them.
test('validatePermissions rejects unknown names and lists the known ones', () => {
  assert.throws(() => validatePermissions(['clipboard-readwrite']), /Unknown permission/);
  assert.throws(() => validatePermissions(['clipboard-readwrite']), /clipboard-read/);
  assert.throws(() => validatePermissions([]), /No permissions/);
});

test('validatePermissions accepts every known name and de-duplicates', () => {
  assert.deepEqual(validatePermissions([...PERMISSION_NAMES]), [...PERMISSION_NAMES]);
  assert.deepEqual(validatePermissions(['camera', 'camera']), ['camera']);
});
