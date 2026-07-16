import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNavigationUrl, validateAllowedDomain, freezeAllowedDomains, checkDomainAllowed, validateBrowserRequest, isSensitiveAction } from '../src/browser-policy.js';

test('browser policy accepts public https URL and rejects credentials/private', () => {
  assert.equal(validateNavigationUrl('https://example.com/path'), 'https://example.com/path');
  assert.throws(() => validateNavigationUrl('https://u:p@example.com'), /credentials/);
  assert.throws(() => validateNavigationUrl('http://localhost:3000'), /private|local/);
});

test('domain policy freezes and matches explicit subdomains', () => {
  assert.deepEqual(freezeAllowedDomains(['*.Example.com', 'cdn.example.net']), ['*.example.com', 'cdn.example.net']);
  assert.equal(validateAllowedDomain('*.example.com'), '*.example.com');
  assert.equal(checkDomainAllowed('assets.example.com', ['*.example.com']), true);
  assert.equal(checkDomainAllowed('example.com', ['*.example.com']), false);
});

test('request action union and sensitive classification', () => {
  assert.equal(validateBrowserRequest({ action: 'snapshot' }).action, 'snapshot');
  assert.throws(() => validateBrowserRequest({ action: 'shell' }), /Unsupported/);
  assert.equal(isSensitiveAction('evaluate'), true);
  assert.equal(isSensitiveAction('text'), false);
});
