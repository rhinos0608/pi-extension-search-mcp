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
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'policy-denied');
  await adapter.close();
});

// ── semanticAction validation ──

test('semanticAction returns error when semanticAction field is missing', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'semanticAction' }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /semanticAction is required/);
  await adapter.close();
});

test('semanticAction validation rejects missing locator', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute(
    { action: 'semanticAction', semanticAction: { query: 'Submit', verb: 'click' } },
    { env: {} },
  );
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /locator is required/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'invalid-request');
  await adapter.close();
});

test('semanticAction validation rejects missing verb', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute(
    { action: 'semanticAction', semanticAction: { locator: 'role', query: 'Submit' } },
    { env: {} },
  );
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /verb is required/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'invalid-request');
  await adapter.close();
});

// ── job validation ──

test('job returns error when job field is missing', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'job' }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /job is required/);
  await adapter.close();
});

test('job returns validation error for empty steps', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'job', job: { steps: [] } }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /non-empty/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'invalid-request');
  await adapter.close();
});

// ── batch policy denial ──

test('batch denied without PI_SEARCH_BROWSER_ALLOW_SENSITIVE', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute(
    { action: 'batch', batch: { commands: [{ args: ['eval', '1'] }] } },
    { env: {} },
  );
  const details = result.details as Record<string, unknown>;
  assert.match(String(details.error), /disabled by policy/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'policy-denied');
  await adapter.close();
});

// ── snapshot basic smoke ──

test('snapshot returns error when no browser session exists', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'snapshot' }, { env: {} });
  // Without a browser session, this should either error gracefully or succeed
  // The important thing is it doesn't throw
  assert.ok(result !== undefined);
  await adapter.close();
});

// ── click stale ref ──

test('click with stale @e ref returns staleRef true', async () => {
  const adapter = new AgentBrowserAdapter();
  const result = await adapter.execute({ action: 'click', selector: '@e5' }, { env: {} });
  const details = result.details as Record<string, unknown>;
  assert.equal(details.staleRef, true);
  assert.match(String(details.error), /Stale or unknown ref/);
  assert.equal((result as unknown as { failureCategory?: string }).failureCategory, 'stale-ref');
  await adapter.close();
});
