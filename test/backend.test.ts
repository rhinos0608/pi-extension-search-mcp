import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchBackend } from '../src/backend.js';

test('createSearchBackend returns backend interface', () => {
  const backend = createSearchBackend({
    SEARCH_MCP_COMMAND: 'node',
    SEARCH_MCP_ARGS_JSON: '["server.js"]',
  });

  assert.equal(typeof backend.callTool, 'function');
  assert.equal(typeof backend.close, 'function');
});
