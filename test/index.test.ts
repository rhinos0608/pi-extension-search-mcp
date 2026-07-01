import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBrowseArgs, buildSemanticSource } from '../src/index.js';

test('buildBrowseArgs uses supported agentic_browse read action', () => {
  assert.deepEqual(buildBrowseArgs({ url: 'https://example.com' }), {
    action: 'read',
    url: 'https://example.com',
    maxChars: 12000,
  });
});

test('buildBrowseArgs preserves explicit maxChars', () => {
  assert.deepEqual(buildBrowseArgs({ url: 'https://example.com', maxChars: 1000 }), {
    action: 'read',
    url: 'https://example.com',
    maxChars: 1000,
  });
});

test('buildSemanticSource prefers explicit URL', () => {
  assert.deepEqual(buildSemanticSource(' https://example.com/page ', 'fallback query'), {
    type: 'url',
    url: 'https://example.com/page',
  });
});

test('buildSemanticSource uses search query when URL is absent', () => {
  assert.deepEqual(buildSemanticSource(' ', 'topic query'), {
    type: 'search',
    query: 'topic query',
    maxSeedUrls: 8,
  });
});

test('buildSemanticSource requires URL or search query', () => {
  assert.throws(() => buildSemanticSource(undefined, '  '), /Provide either url or searchQuery/);
});
