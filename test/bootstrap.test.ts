import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapInstallArgs, callSetupTool } from '../src/bootstrap.js';

test('bootstrapInstallArgs supports documented install_all mode', () => {
  assert.deepEqual(bootstrapInstallArgs('install_all'), ['install', '--env=auto', '--channels=all']);
});

test('bootstrapInstallArgs supports install_core mode', () => {
  assert.deepEqual(bootstrapInstallArgs('install_core'), ['install', '--env=auto']);
});

test('bootstrapInstallArgs treats safe mode as gated install command', () => {
  assert.deepEqual(bootstrapInstallArgs('safe'), ['install', '--env=auto', '--safe']);
});

test('reach_setup install remains blocked without explicit allow env', async () => {
  const result = await callSetupTool({ action: 'install_all' }, { env: {} });

  assert.match(JSON.stringify(result.details), /PI_SEARCH_ALLOW_INSTALL=1/);
});
