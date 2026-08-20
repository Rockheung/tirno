import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_BACKENDS,
  CLOUD_BACKENDS,
  ALL_BACKENDS,
  DEFAULT_BACKEND,
  type BackendName,
} from '../src/vision/types.js';
import { getBackend } from '../src/vision/ocr.js';

test('ALL_BACKENDS = LOCAL ∪ CLOUD with no overlap', () => {
  const overlap = LOCAL_BACKENDS.filter(n => CLOUD_BACKENDS.includes(n as never));
  assert.equal(overlap.length, 0);
  assert.deepEqual(ALL_BACKENDS, [...LOCAL_BACKENDS, ...CLOUD_BACKENDS]);
});

test('DEFAULT_BACKEND is a known backend and local', () => {
  assert.ok(ALL_BACKENDS.includes(DEFAULT_BACKEND));
  assert.ok(LOCAL_BACKENDS.includes(DEFAULT_BACKEND as never));
});

test('every backend is loadable and has correct kind', async () => {
  for (const name of ALL_BACKENDS) {
    const b = await getBackend(name as BackendName);
    assert.ok(b.name);
    assert.ok(b.kind === 'local' || b.kind === 'cloud');
    if (LOCAL_BACKENDS.includes(name as never)) {
      assert.equal(b.kind, 'local', `${name} should be local`);
    } else {
      assert.equal(b.kind, 'cloud', `${name} should be cloud`);
    }
  }
});

test('cloud backend stubs throw with clear message when API key absent', async () => {
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    const claude = await getBackend('claude');
    await assert.rejects(claude.recognize(Buffer.from(''), {}), /ANTHROPIC_API_KEY/);

    const openai = await getBackend('openai');
    await assert.rejects(openai.recognize(Buffer.from(''), {}), /OPENAI_API_KEY/);

    const gemini = await getBackend('gemini');
    await assert.rejects(gemini.recognize(Buffer.from(''), {}), /GEMINI_API_KEY/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('cloud backend stubs throw "not implemented" when key is set', async () => {
  const orig = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fake-test-key';
  try {
    const claude = await getBackend('claude');
    await assert.rejects(claude.recognize(Buffer.from(''), {}), /not yet implemented/);
  } finally {
    if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = orig;
  }
});
