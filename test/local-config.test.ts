import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadedConfigSummary, loadSearchMcpEnvironment } from '../src/local-config.js';

test('loadSearchMcpEnvironment does not assume a developer-specific default config path', () => {
  const env = { PI_SEARCH_ENV_PATH: '/tmp/missing-pi-search-env' };
  assert.deepEqual(loadSearchMcpEnvironment(env), env);
  assert.deepEqual(loadedConfigSummary(env), { path: '', loaded: false, mappedKeys: [] });
});

test('loadSearchMcpEnvironment loads package env file before config mapping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-env-'));
  const envPath = join(dir, '.env');
  const configPath = join(dir, 'config.json');
  await writeFile(envPath, `PI_SEARCH_BOOTSTRAP=auto\nSEARCH_MCP_CONFIG_PATH=${configPath}\nEXA_API_KEY=from-env-file\n`);
  await writeFile(configPath, JSON.stringify({ exa: { apiKey: 'from-config' }, github: { token: 'gh-token' } }));

  const env = loadSearchMcpEnvironment({ PI_SEARCH_ENV_PATH: envPath });

  assert.equal(env.PI_SEARCH_BOOTSTRAP, 'auto');
  assert.equal(env.SEARCH_MCP_CONFIG_PATH, configPath);
  assert.equal(env.EXA_API_KEY, 'from-env-file');
  assert.equal(env.GITHUB_TOKEN, 'gh-token');
});

test('loadSearchMcpEnvironment maps search-mcp config keys without overriding env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    exa: { apiKey: 'from-config' },
    github: { token: 'gh-token' },
    crawl4ai: { baseUrl: 'https://crawl.example', apiToken: 'crawl-token' },
  }));

  const env = loadSearchMcpEnvironment({ PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path, EXA_API_KEY: 'from-env' });

  assert.equal(env.EXA_API_KEY, 'from-env');
  assert.equal(env.GITHUB_TOKEN, 'gh-token');
  assert.equal(env.CRAWL4AI_BASE_URL, 'https://crawl.example');
  assert.equal(env.CRAWL4AI_API_TOKEN, 'crawl-token');
});

test('loadedConfigSummary reports keys only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ brave: { apiKey: 'secret' } }));

  assert.deepEqual(loadedConfigSummary({ PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path }), {
    path,
    loaded: true,
    mappedKeys: ['BRAVE_API_KEY'],
  });
});

test('loadSearchMcpEnvironment ignores malformed config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, '{bad json');

  const env = { PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path };
  assert.deepEqual(loadSearchMcpEnvironment(env), env);
  assert.deepEqual(loadedConfigSummary(env), { path, loaded: false, mappedKeys: [] });
});

test('loadSearchMcpEnvironment ignores placeholder null strings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-search-config-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ llm: { apiToken: 'null' } }));

  assert.equal(loadSearchMcpEnvironment({ PI_SEARCH_ENV_PATH: join(dir, 'missing.env'), SEARCH_MCP_CONFIG_PATH: path }).SEARCH_LLM_API_TOKEN, undefined);
});
