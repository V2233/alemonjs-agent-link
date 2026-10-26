import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getDSHConfig, watchDSHConfig } from '../lib/dsh/runtime-config.js';
import { getDSHCredentials } from '../lib/dsh/credentials.js';
import { getMediaConfig } from '../lib/media/config.js';

test('application config reads current values, framework path, defaults and validation', async () => {
  const original = globalThis.__config;
  const config = { path: join(process.cwd(), 'test-config', 'alemon.yaml'), value: { 'alemonjs-agent-link': { workspaceRoot: 'work', apiKey: ' test-key ' } } };
  globalThis.__config = config;
  try {
    assert.equal(getDSHConfig().workspaceRoot, join(process.cwd(), 'test-config', 'work'));
    assert.equal(getDSHConfig().requestTimeoutMs, 120000);
    assert.equal((await getDSHCredentials()).apiKey, 'test-key');
    config.value['alemonjs-agent-link'].media = { timeoutMs: 5000 };
    assert.equal(getMediaConfig().timeoutMs, 5000);
    config.value.db = { redis: {} };
    assert.equal(getDSHConfig().stateBackend, 'redis');
    config.value['alemonjs-agent-link'].requestTimeoutMs = 0;
    assert.throws(() => getDSHConfig(), /requestTimeoutMs/);
    delete config.value['alemonjs-agent-link'].apiKey;
    assert.equal(await getDSHCredentials(), null);
  } finally {
    globalThis.__config = original;
  }
});

test('application watch filters unrelated changes, preserves Redis fallback, deduplicates and disposes', () => {
  const original = globalThis.__config;
  const listeners = new Set();
  const config = {
    value: { 'alemonjs-agent-link': { model: 'first' } },
    onWatch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  globalThis.__config = config;
  const received = [];
  const emit = () => {
    for (const listener of listeners) listener(config.value);
  };
  let stop;
  try {
    stop = watchDSHConfig(() => received.push(getDSHConfig()));
    config.value.other = { enabled: true };
    emit();
    assert.equal(received.length, 0);
    config.value['alemonjs-agent-link'].model = 'second';
    config.value.db = { redis: {} };
    emit();
    assert.equal(received.length, 1);
    assert.equal(received[0].model, 'second');
    assert.equal(received[0].stateBackend, 'redis');
    delete config.value.db;
    emit();
    assert.equal(received.length, 2);
    assert.equal(received[1].stateBackend, 'local');
    config.value['alemonjs-agent-link'].stateBackend = 'local';
    emit();
    config.value.db = { redis: {} };
    emit();
    assert.equal(received.length, 3);
    stop();
    stop();
    assert.equal(listeners.size, 0);
    config.value['alemonjs-agent-link'].model = 'third';
    emit();
    assert.equal(received.length, 3);
  } finally {
    stop?.();
    globalThis.__config = original;
  }
});
