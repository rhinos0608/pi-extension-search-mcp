import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchBackend } from '../src/backend.js';
import { buildCliEnvironment } from '../src/cli-backend.js';

test('createSearchBackend returns backend interface', () => {
  const backend = createSearchBackend({
    SEARCH_MCP_COMMAND: 'node',
    SEARCH_MCP_ARGS_JSON: '["server.js"]',
  });

  assert.equal(typeof backend.callTool, 'function');
  assert.equal(typeof backend.close, 'function');
});

test('buildCliEnvironment forwards reach backend auth and override allowlist', () => {
  assert.deepEqual(buildCliEnvironment({
    PATH: '/usr/bin',
    TWITTER_AUTH_TOKEN: 'token',
    TWITTER_CT0: 'ct0',
    TWITTER_BACKEND: 'OpenCLI',
    PI_SEARCH_REDDIT_BACKEND: 'rdt',
    HTTPS_PROXY: 'http://proxy.example',
    EXA_API_KEY: 'exa',
    SEARCH_MCP_CONFIG_PATH: '/tmp/config.json',
    DATABASE_URL: 'secret',
  }), {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy.example',
    TWITTER_AUTH_TOKEN: 'token',
    TWITTER_CT0: 'ct0',
    EXA_API_KEY: 'exa',
    SEARCH_MCP_CONFIG_PATH: '/tmp/config.json',
    TWITTER_BACKEND: 'OpenCLI',
    PI_SEARCH_REDDIT_BACKEND: 'rdt',
  });
});
