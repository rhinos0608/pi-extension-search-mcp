import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentBrowserAdapter } from '../src/agent-browser.js';

test('adapter status reports exact executable version without browser launch', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.status();
  assert.match(String(result.details && (result.details as Record<string, unknown>).version), /0\.32\.0/);
  await adapter.close();
});

test('sensitive actions disabled by default via policy', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'evaluate', expression: '1+1' }, { env: {} });
  assert.match(String(result.details && (result.details as Record<string, unknown>).error), /disabled by policy/);
  await adapter.close();
});
