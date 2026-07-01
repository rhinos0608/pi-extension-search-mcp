import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callNativeTool } from '../src/native-tools.js';

test('callNativeTool rejects unsupported tools', async () => {
  await assert.rejects(
    () => callNativeTool('missing_tool', {}),
    /Unsupported native tool/,
  );
});

test('native browse rejects private localhost URLs before fetching', async () => {
  await assert.rejects(
    () => callNativeTool('agentic_browse', { action: 'read', url: 'http://localhost:3000' }),
    /Disallowed private or local host/,
  );
});

test('native browse rejects non-http URL schemes', async () => {
  await assert.rejects(
    () => callNativeTool('agentic_browse', { action: 'read', url: 'file:///etc/passwd' }),
    /Disallowed URL scheme/,
  );
});
