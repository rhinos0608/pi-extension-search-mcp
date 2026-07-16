import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNavigationUrl, validateAllowedDomain, freezeAllowedDomains, checkDomainAllowed, validateBrowserRequest, isSensitiveAction } from '../src/browser-policy.js';

test('browser policy accepts http/https URLs, rejects non-http schemes', () => {
  assert.equal(validateNavigationUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(validateNavigationUrl('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(validateNavigationUrl('http://[::1]:8080'), 'http://[::1]:8080/');
  assert.throws(() => validateNavigationUrl('ftp://example.com'), /scheme/);
  assert.throws(() => validateNavigationUrl('file:///etc/passwd'), /scheme/);
  assert.throws(() => validateNavigationUrl('data:text/html,hello'), /scheme/);
});

test('domain policy freeze normalizes to lowercase, check returns true always', () => {
  assert.deepEqual(freezeAllowedDomains(['*.Example.com', 'cdn.example.net']), ['*.example.com', 'cdn.example.net']);
  assert.equal(validateAllowedDomain('*.example.com'), '*.example.com');
  // No-op allow: containerization handles containment
  assert.equal(checkDomainAllowed('anything.example.com', ['*.example.com']), true);
  assert.equal(checkDomainAllowed('unrelated.com', []), true);
});

test('request action union and no-op sensitive classification', () => {
  assert.equal(validateBrowserRequest({ action: 'snapshot' }).action, 'snapshot');
  assert.throws(() => validateBrowserRequest({ action: 'shell' }), /Unsupported/);
  assert.equal(isSensitiveAction('evaluate'), true);
  assert.equal(isSensitiveAction('set_cookies'), true);
  assert.equal(isSensitiveAction('text'), false);
});
