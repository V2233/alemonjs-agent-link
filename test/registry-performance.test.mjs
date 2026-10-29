import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../lib/state/registry.js';
import { getDSHConfig } from '../lib/dsh/client.js';

test('ready Redis business reads avoid probes; health and reconnect still probe', async () => {
  const previous = globalThis.ioRedis;
  let probes = 0;
  let reads = 0;
  let unavailable = false;
  const client = {
    status: 'ready',
    ping: async () => {
      probes++;
      if (unavailable) throw new Error('offline');
      return 'PONG';
    },
    get: async () => {
      reads++;
      if (unavailable) throw new Error('offline');
      return null;
    }
  };
  globalThis.ioRedis = client;
  try {
    const registry = new SessionRegistry(getDSHConfig({ stateBackend: 'redis' }));
    await registry.ready();
    assert.equal(probes, 1);
    for (let i = 0; i < 100; i++) await registry.meta('performance-test');
    assert.equal(reads, 100);
    assert.equal(probes, 1);
    assert.equal(await registry.health(), true);
    assert.equal(probes, 2);
    client.status = 'connecting';
    await registry.meta('performance-test');
    assert.equal(probes, 3);
    unavailable = true;
    await assert.rejects(registry.meta('performance-test'), /状态库不可用/);
    client.status = 'ready';
    await assert.rejects(registry.meta('performance-test'), /offline/);
    assert.equal(await registry.health(), false);
  } finally {
    globalThis.ioRedis = previous;
  }
});
