import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeProviderPayload } from '../src/payload.js';

test('normalizeProviderPayload leaves string instructions unchanged', () => {
  const payload = { instructions: 'hello', input: [] };

  assert.equal(normalizeProviderPayload(payload), payload);
});

test('normalizeProviderPayload converts object instructions to text', () => {
  const payload = { instructions: { text: 'hello' }, input: [] };

  assert.deepEqual(normalizeProviderPayload(payload), { instructions: 'hello', input: [] });
});

test('normalizeProviderPayload joins array instructions', () => {
  const payload = { instructions: [{ text: 'alpha' }, 'beta'], input: [] };

  assert.deepEqual(normalizeProviderPayload(payload), { instructions: 'alpha\nbeta', input: [] });
});
