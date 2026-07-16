import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSandboxEnvironment, generateNamespace, parseAgentBrowserOutput } from '../src/agent-browser-process.js';

test('sandbox environment strips hostile inherited variables', () => {
  const env = buildSandboxEnvironment({ PATH: '/bin', HOME: '/tmp', AGENT_BROWSER_SESSION: 'evil', NODE_OPTIONS: '--import evil', GITHUB_TOKEN: 'secret' }, { runtimeRoot: '/tmp/pi', namespace: 'owned' });
  assert.equal(env.AGENT_BROWSER_SESSION, 'owned');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AGENT_BROWSER_CONFIG, '/tmp/pi/config/config.json');
});

test('output parser accepts JSON envelopes and ignores diagnostics', () => {
  assert.deepEqual(parseAgentBrowserOutput('diagnostic\n{"success":true,"data":{"ok":1}}\n'), [{ success: true, data: { ok: 1 } }]);
  assert.deepEqual(parseAgentBrowserOutput('[{"success":false,"error":"bad"}]'), [{ success: false, error: 'bad' }]);
});

test('namespace is unique-shaped', () => assert.match(generateNamespace(), /^pi-/));
