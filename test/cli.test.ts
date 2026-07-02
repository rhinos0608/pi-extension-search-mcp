import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../src/cli.js';

test('runCommand status reports native CLI backend configuration', async () => {
  assert.deepEqual(await runCommand(['status'], { SEARCH_MCP_COMMAND: 'node', SEARCH_MCP_ARGS_JSON: '["server.js"]' }), {
    ok: true,
    data: {
      backend: 'native-cli',
      command: 'node',
      args: ['server.js'],
      cwd: null,
      defaultCommand: 'search-mcp',
    },
  });
});

test('runCommand config reports env-facing settings', async () => {
  assert.deepEqual(await runCommand(['config'], { SEARCH_MCP_CWD: '/tmp/search-mcp' }), {
    ok: true,
    data: {
      searchBackend: 'native-cli',
      searchMcpCommand: 'search-mcp',
      searchMcpArgsJson: '[]',
      searchMcpCwd: '/tmp/search-mcp',
    },
  });
});

test('runCommand rejects unknown commands', async () => {
  const result = await runCommand(['unknown'], {});

  assert.equal(result.ok, false);
  assert.deepEqual(result.error, {
    code: 'unknown_command',
    message: 'Usage: pi-extension-search <status|config|call TOOL JSON_ARGS>',
  });
});

test('runCommand validates call args', async () => {
  const result = await runCommand(['call', 'web_search', '[]'], {});

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'invalid_args');
});

test('runCommand routes call through native tools', async () => {
  const result = await runCommand(['call', 'agentic_browse', '{"action":"read","url":"file:///etc/passwd"}'], {});

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'tool_error');
  assert.match(result.error?.message ?? '', /Disallowed URL scheme/);
});

test('runCommand supports public browse tool alias', async () => {
  const result = await runCommand(['call', 'browse', '{"url":"file:///etc/passwd"}'], {});

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'tool_error');
  assert.match(result.error?.message ?? '', /Disallowed URL scheme/);
});

test('runCommand supports reach_status family', async () => {
  const result = await runCommand(['call', 'reach_status', '{"family":"feeds"}'], {});

  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result.data), /native-rss-atom/);
});
