import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initializeAdminPanel, disposeAdminPanel } from '../lib/panel/admin-panel.js';
import { readPoolSettings, updatePoolSettings } from '../lib/panel/pool-settings.js';

for (const [name, pool] of [
  ['key strings', { keys: ['secret-original-111', 'secret-original-222'], strategy: 'least-busy' }],
  [
    'legacy object',
    {
      enabled: false,
      provider: 'test',
      baseUrl: 'https://example.com/v1',
      model: 'custom',
      keys: [{ id: 'old-id', key: 'secret-original-111', enabled: false, weight: 3, api: 'https://override.example/v1' }]
    }
  ],
  ['array shorthand', ['secret-original-111', 'secret-original-222']]
])
  test('legacy pool can be edited without manual migration: ' + name, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-legacy-'));
    const path = join(dir, 'config.yaml');
    const previous = globalThis.__config;
    try {
      await writeFile(path, JSON.stringify({ other: { preserve: true }, 'alemonjs-agent-link': { modelPool: pool } }));
      globalThis.__config = { path, value: {}, reload() {} };
      await initializeAdminPanel();
      const first = await readPoolSettings();
      assert.ok(!JSON.stringify(first).includes('secret-original'));
      assert.equal(first.modelPool.endpoints.length, Array.isArray(pool) ? 2 : pool.keys.length);
      const endpoint = first.modelPool.endpoints[0];
      await updatePoolSettings({ revision: first.revision, action: 'endpoint', id: endpoint.id, values: { ...endpoint, model: 'updated-model' } });
      const saved = parse(await readFile(path, 'utf8'));
      const updated = saved['alemonjs-agent-link'].modelPool;
      assert.equal(updated.keys, undefined);
      assert.equal(updated.endpoints[0].model, 'updated-model');
      assert.equal(updated.endpoints[0].apiKey, 'secret-original-111');
      assert.equal(saved.other.preserve, true);
      if (name === 'legacy object') {
        assert.equal(updated.enabled, false);
        assert.equal(updated.endpoints[0].enabled, false);
        assert.equal(updated.endpoints[0].weight, undefined);
        assert.equal(updated.endpoints[0].baseUrl, 'https://override.example/v1');
      }
      if (name === 'key strings') assert.equal(updated.strategy, undefined);
      const current = await readPoolSettings();
      await assert.rejects(updatePoolSettings({ revision: first.revision, action: 'endpoint', id: endpoint.id, values: { model: 'stale' } }), /变化/);
      await updatePoolSettings({ revision: current.revision, action: 'remove', id: endpoint.id });
      assert.equal((await readPoolSettings()).modelPool.endpoints.length, first.modelPool.endpoints.length - 1);
    } finally {
      disposeAdminPanel();
      globalThis.__config = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

test('custom balance URL and endpoint participation persist even while rotation is paused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-settings-'));
  const path = join(dir, 'config.yaml');
  const previous = globalThis.__config;
  try {
    await writeFile(
      path,
      JSON.stringify({
        'alemonjs-agent-link': {
          modelPool: {
            enabled: false,
            endpoints: [{ id: 'first', provider: 'test', baseUrl: 'https://example.com', model: 'test', apiKey: 'secret-original-key' }]
          }
        }
      })
    );
    globalThis.__config = { path, value: {}, reload() {} };
    await initializeAdminPanel();
    const first = await readPoolSettings();
    await assert.rejects(
      updatePoolSettings({ revision: first.revision, action: 'endpoint', id: 'first', values: { balanceUrl: 'http://example.com/{key}' } }),
      /HTTPS/
    );
    assert.equal((await readPoolSettings()).revision, first.revision);
    const balanceUrl = 'https://example.com/balance?key={key}';
    await updatePoolSettings({ revision: first.revision, action: 'endpoint', id: 'first', values: { balanceUrl, enabled: false } });
    const saved = parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].modelPool;
    assert.equal(saved.enabled, false);
    assert.equal(saved.endpoints[0].enabled, false);
    assert.equal(saved.endpoints[0].balanceUrl, balanceUrl);
    assert.equal(saved.endpoints[0].apiKey, 'secret-original-key');
    const current = await readPoolSettings();
    await updatePoolSettings({ revision: current.revision, action: 'endpoint', id: 'first', values: { balanceUrl: null, enabled: true } });
    const updated = (await readPoolSettings()).modelPool;
    assert.equal(updated.enabled, false);
    assert.equal(updated.endpoints[0].enabled, true);
    assert.equal(updated.endpoints[0].balanceUrl, undefined);
  } finally {
    disposeAdminPanel();
    globalThis.__config = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
