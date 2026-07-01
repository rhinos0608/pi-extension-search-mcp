import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resultToText } from '../src/backend.js';
import { buildServerParameters, DEFAULT_SEARCH_MCP_COMMAND } from '../src/mcp-client.js';

test('buildServerParameters uses search-mcp defaults', () => {
  const params = buildServerParameters({});

  assert.equal(params.command, DEFAULT_SEARCH_MCP_COMMAND);
  assert.deepEqual(params.args, []);
  assert.equal(params.stderr, 'pipe');
});

test('buildServerParameters accepts JSON args and cwd from environment', () => {
  const params = buildServerParameters({
    SEARCH_MCP_COMMAND: 'node',
    SEARCH_MCP_ARGS_JSON: '["dist/index.js", "--json"]',
    SEARCH_MCP_CWD: '/tmp/search-mcp',
  });

  assert.equal(params.command, 'node');
  assert.deepEqual(params.args, ['dist/index.js', '--json']);
  assert.equal(params.cwd, '/tmp/search-mcp');
});

test('buildServerParameters rejects invalid JSON args', () => {
  assert.throws(
    () => buildServerParameters({ SEARCH_MCP_ARGS_JSON: '{"bad": true}' }),
    /SEARCH_MCP_ARGS_JSON must be a JSON string array/,
  );
});

test('buildServerParameters rejects non-string JSON args', () => {
  assert.throws(
    () => buildServerParameters({ SEARCH_MCP_ARGS_JSON: '["ok", 1]' }),
    /SEARCH_MCP_ARGS_JSON must be a JSON string array/,
  );
});

test('buildServerParameters falls back when command is blank', () => {
  const params = buildServerParameters({ SEARCH_MCP_COMMAND: '   ' });

  assert.equal(params.command, DEFAULT_SEARCH_MCP_COMMAND);
});

test('buildServerParameters filters inherited environment', () => {
  const params = buildServerParameters({
    PATH: '/usr/bin',
    DATABASE_URL: 'secret',
    SEARCH_MCP_CWD: '/tmp/search-mcp',
    SEARCH_MCP_FORWARD_ENV_JSON: '["CUSTOM_ALLOWED"]',
    CUSTOM_ALLOWED: 'ok',
  });

  assert.deepEqual(params.env, {
    PATH: '/usr/bin',
    SEARCH_MCP_CWD: '/tmp/search-mcp',
    SEARCH_MCP_FORWARD_ENV_JSON: '["CUSTOM_ALLOWED"]',
    CUSTOM_ALLOWED: 'ok',
  });
});

test('buildServerParameters rejects invalid forwarded env list', () => {
  assert.throws(
    () => buildServerParameters({ SEARCH_MCP_FORWARD_ENV_JSON: '[1]' }),
    /SEARCH_MCP_FORWARD_ENV_JSON must be a JSON string array/,
  );
});

test('resultToText keeps text content and serializes non-text content', () => {
  const text = resultToText({
    content: [
      { type: 'text', text: 'alpha' },
      { type: 'image', mimeType: 'image/png', data: 'abc' },
    ],
  });

  assert.equal(text, 'alpha\n{"type":"image","mimeType":"image/png","data":"abc"}');
});

test('resultToText serializes non-content results', () => {
  assert.equal(resultToText({ ok: true }), '{\n  "ok": true\n}');
});

test('resultToText handles undefined content items', () => {
  assert.equal(resultToText({ content: [undefined] }), 'undefined');
});
