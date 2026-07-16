import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNavigationUrl, validateAllowedDomain, freezeAllowedDomains, checkDomainAllowed, validateBrowserRequest, isSensitiveAction, validateSemanticActionRequest, validateBatchRequest } from '../src/browser-policy.js';

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

test('request accepts semanticAction and batch actions', () => {
  assert.equal(validateBrowserRequest({ action: 'semanticAction' }).action, 'semanticAction');
  assert.equal(validateBrowserRequest({ action: 'job' }).action, 'job');
  assert.equal(validateBrowserRequest({ action: 'batch' }).action, 'batch');
});

// ── Component 9: validateSemanticActionRequest ──

test('validateSemanticActionRequest rejects missing locator', () => {
  assert.throws(() => validateSemanticActionRequest({ query: 'button', verb: 'click' }), /locator/);
});

test('validateSemanticActionRequest rejects invalid locator', () => {
  assert.throws(() => validateSemanticActionRequest({ locator: 'invalid', query: 'x', verb: 'click' }), /locator/);
});

test('validateSemanticActionRequest rejects missing query', () => {
  assert.throws(() => validateSemanticActionRequest({ locator: 'role', verb: 'click' }), /query/);
});

test('validateSemanticActionRequest rejects missing verb', () => {
  assert.throws(() => validateSemanticActionRequest({ locator: 'role', query: 'button' }), /verb/);
});

test('validateSemanticActionRequest rejects invalid verb', () => {
  assert.throws(() => validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'invalid' }), /verb/);
});

test('validateSemanticActionRequest requires index for nth locator', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'nth', query: 'button', verb: 'click' }),
    /index is required when locator is nth/,
  );
});

test('validateSemanticActionRequest requires value for fill verb', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', query: 'textbox', verb: 'fill' }),
    /value is required when verb is fill/,
  );
});

test('validateSemanticActionRequest requires value for type verb', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', query: 'textbox', verb: 'type' }),
    /value is required when verb is type/,
  );
});

test('validateSemanticActionRequest requires value for select verb', () => {
  assert.throws(
    () => validateSemanticActionRequest({ locator: 'role', query: 'select', verb: 'select' }),
    /value is required when verb is select/,
  );
});

test('validateSemanticActionRequest accepts valid role click', () => {
  const r = validateSemanticActionRequest({ locator: 'role', query: 'button', verb: 'click', name: 'Submit', exact: true });
  assert.equal(r.locator, 'role');
  assert.equal(r.query, 'button');
  assert.equal(r.verb, 'click');
  assert.equal(r.name, 'Submit');
  assert.equal(r.exact, true);
});

test('validateSemanticActionRequest accepts valid nth locator with index', () => {
  const r = validateSemanticActionRequest({ locator: 'nth', query: 'button', verb: 'click', index: 2 });
  assert.equal(r.index, 2);
});

test('validateSemanticActionRequest accepts valid fill with value', () => {
  const r = validateSemanticActionRequest({ locator: 'role', query: 'textbox', verb: 'fill', value: 'hello' });
  assert.equal(r.value, 'hello');
});

// ── Component 11: validateBatchRequest ──

test('validateBatchRequest rejects empty commands', () => {
  assert.throws(() => validateBatchRequest({ commands: [] }), /non-empty/);
});

test('validateBatchRequest rejects exceeding maxCommands', () => {
  const commands = Array.from({ length: 5 }, () => ({ args: ['click', '#btn'] }));
  assert.throws(() => validateBatchRequest({ commands, maxCommands: 3 }), /too many commands/);
});

test('validateBatchRequest rejects command with empty args', () => {
  assert.throws(() => validateBatchRequest({ commands: [{ args: [] }] }), /args is required/);
});

test('validateBatchRequest accepts valid commands', () => {
  const r = validateBatchRequest({ commands: [{ args: ['click', '#btn'] }, { args: ['type', '#input', 'hello'] }] });
  assert.equal(r.commands.length, 2);
  assert.equal(r.commands[0]!.args[0], 'click');
  assert.equal(r.commands[0]!.sensitive, true); // default
});

test('validateBatchRequest preserves sensitive flag', () => {
  const r = validateBatchRequest({ commands: [{ args: ['snapshot'], sensitive: false }] });
  assert.equal(r.commands[0]!.sensitive, false);
});

test('batch is classified as sensitive action', () => {
  assert.equal(isSensitiveAction('batch'), true);
});
