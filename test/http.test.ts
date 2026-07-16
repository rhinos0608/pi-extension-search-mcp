import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeResponseText, validatePublicHttpUrl } from '../src/http.js';

test('validatePublicHttpUrl accepts http/https and rejects non-http schemes only', () => {
  assert.equal(validatePublicHttpUrl('https://fdns.google/path'), 'https://fdns.google/path');
  assert.equal(validatePublicHttpUrl('https://fccdn.example/path'), 'https://fccdn.example/path');
  // Private/local hosts now pass — containerization handles network containment
  assert.equal(validatePublicHttpUrl('http://[fd00::1]/'), 'http://[fd00::1]/');
  assert.equal(validatePublicHttpUrl('http://[fc00::1]/'), 'http://[fc00::1]/');
  assert.equal(validatePublicHttpUrl('http://metadata.google.internal/'), 'http://metadata.google.internal/');
  assert.equal(validatePublicHttpUrl('http://localhost:3000/'), 'http://localhost:3000/');
  assert.throws(() => validatePublicHttpUrl('ftp://example.com'), /scheme/);
  assert.throws(() => validatePublicHttpUrl('file:///etc/passwd'), /scheme/);
});

test('safeResponseText rejects content-length over cap', async () => {
  const response = new Response('', { headers: { 'content-length': '10' } });
  await assert.rejects(() => safeResponseText(response, 'https://example.com', 5), /too large/);
});
