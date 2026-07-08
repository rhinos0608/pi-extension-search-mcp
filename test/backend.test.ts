import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSearchBackend, resultToText } from '../src/backend.js';
import { buildCliEnvironment } from '../src/cli-backend.js';

test('createSearchBackend returns backend interface', () => {
  const backend = createSearchBackend({
    SEARCH_MCP_COMMAND: 'node',
    SEARCH_MCP_ARGS_JSON: '["server.js"]',
  });

  assert.equal(typeof backend.callTool, 'function');
  assert.equal(typeof backend.close, 'function');
});

test('import.meta.resolve("tsx") resolves to absolute file URL for CLI subprocess', () => {
  const resolved = import.meta.resolve('tsx');
  assert.ok(resolved.startsWith('file://'), `tsx must resolve to file:// URL, got: ${resolved}`);
  assert.ok(resolved.endsWith('loader.mjs'), `tsx must resolve to loader.mjs, got: ${resolved}`);
});

test('CliSearchBackend child process works from a foreign cwd', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-cwd-'));
  const backend = createSearchBackend({});

  try {
    process.chdir(dir);
    const result = await backend.callTool('reach_status', { family: 'feeds' }, { timeout: 60_000 });
    assert.match(resultToText(result), /native-rss-atom/);
  } finally {
    process.chdir(originalCwd);
    await backend.close();
    await rm(dir, { recursive: true, force: true });
  }
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
    PI_SEARCH_BROWSER_AUTOMATION: '0',
    BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
    BROWSER_EXECUTABLE_PATH: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    DATABASE_URL: 'secret',
  }), {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy.example',
    TWITTER_AUTH_TOKEN: 'token',
    TWITTER_CT0: 'ct0',
    EXA_API_KEY: 'exa',
    SEARCH_MCP_CONFIG_PATH: '/tmp/config.json',
    PI_SEARCH_BROWSER_AUTOMATION: '0',
    BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
    BROWSER_EXECUTABLE_PATH: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    TWITTER_BACKEND: 'OpenCLI',
    PI_SEARCH_REDDIT_BACKEND: 'rdt',
  });
});
