import test from 'node:test';
import assert from 'node:assert/strict';
import { poolSnapshot, poolAction, poolBalances } from '../lib/panel/pool-service.js';
import { stopCredentialPool } from '../lib/credentials/pool.js';

test('rotation management exposes no credentials and runtime toggles do not write configuration', async () => {
  const previous = globalThis.__config;
  const value = { 'alemonjs-agent-link': { modelPool: { probeIntervalSeconds: 0, endpoints: [{ id: 'first', provider: 'test', baseUrl: 'https://example.com', model: 'test-model', apiKey: 'test-private-secret' }] } } };
  globalThis.__config = { value };
  try {
    const snapshot = await poolSnapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.endpoints[0].id, 'first');
    assert.ok(!JSON.stringify(snapshot).includes('test-private-secret'));
    assert.equal((await poolAction('first', 'disable')).endpoints[0].disabled, true);
    assert.equal(value['alemonjs-agent-link'].modelPool.endpoints[0].enabled, undefined);
    assert.equal((await poolAction('first', 'enable')).endpoints[0].disabled, false);
    await assert.rejects(poolAction('missing', 'disable'), /端点不存在/);
    await assert.rejects(poolAction('first', 'unexpected'), /无效/);
    value['alemonjs-agent-link'].modelPool = { enabled: false };
    assert.equal((await poolSnapshot()).enabled, false);
    assert.deepEqual(await poolBalances(), {});
  } finally { stopCredentialPool(); globalThis.__config = previous; }
});
