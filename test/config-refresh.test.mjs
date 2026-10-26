import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/client.js';
import { ensureDSHSupervisor, setDSHBridgeForTesting } from '../lib/dsh/supervisor.js';

test('model credentials and endpoint refresh in the same process, unchanged config reuses supervisor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-config-refresh-'));
  const originalConfig = globalThis.__config;
  const originalFetch = globalThis.fetch;
  const base = { runtimeMode: 'chat-only', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') };
  const apply = fields => {
    globalThis.__config = { value: { 'alemonjs-agent-link': { ...base, ...fields } } };
  };
  let supervisor;
  const requests = [];
  setDSHBridgeForTesting(null);
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), auth: options.headers.Authorization, model: JSON.parse(options.body).model });
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  };
  try {
    apply({});
    const missing = await ensureDSHSupervisor(getDSHConfig());
    await missing.start();
    apply({ apiKey: 'first-test-key', baseUrl: 'https://first.test/v1', model: 'first-model' });
    supervisor = await ensureDSHSupervisor(getDSHConfig());
    assert.notEqual(supervisor, missing);
    await supervisor.start();
    await supervisor.chatDirect('hi', new AbortController().signal, async () => {});
    assert.equal(await ensureDSHSupervisor(getDSHConfig()), supervisor);
    apply({ apiKey: 'second-test-key', baseUrl: 'https://second.test/v1', model: 'second-model' });
    const previous = supervisor;
    supervisor = await ensureDSHSupervisor(getDSHConfig());
    assert.notEqual(supervisor, previous);
    assert.equal(previous.status().phase, 'stopped');
    await supervisor.start();
    await supervisor.chatDirect('hi', new AbortController().signal, async () => {});
    assert.deepEqual(requests, [
      { url: 'https://first.test/v1/chat/completions', auth: 'Bearer first-test-key', model: 'first-model' },
      { url: 'https://second.test/v1/chat/completions', auth: 'Bearer second-test-key', model: 'second-model' }
    ]);
    apply({});
    supervisor = await ensureDSHSupervisor(getDSHConfig());
    await assert.rejects(
      supervisor.chatDirect('hi', new AbortController().signal, async () => {}),
      /API Key/
    );
    assert.equal(requests.length, 2);
  } finally {
    supervisor?.stop();
    globalThis.fetch = originalFetch;
    globalThis.__config = originalConfig;
    await rm(root, { recursive: true, force: true });
  }
});
