import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialPool, getCredentialPool, modelPoolForBridge } from '../lib/credentials/pool.js';
import { parseModelPool } from '../lib/model-pool/config.js';
import { requestModelMessage } from '../lib/agent/tool-chat.js';
import { getDSHCredentials } from '../lib/dsh/credentials.js';
import { directChat } from '../lib/dsh/direct-chat.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';

const config = {
  apiKey: 'sk-legacy-000000',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  provider: 'deepseek-official',
  modelPool: {
    enabled: true,
    maxAttempts: 2,
    cooldownSeconds: 60,
    endpoints: [
      { id: 'a', apiKey: 'sk-aaaaaaaa', model: 'deepseek-v4-flash', weight: 1, maxConcurrent: 1 },
      { id: 'b', apiKey: 'sk-bbbbbbbb', model: 'deepseek-v4-pro', weight: 1, maxConcurrent: 1 }
    ]
  }
};

test('model pool validates endpoints, model and key shape', () => {
  const pool = parseModelPool(config.modelPool, { provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.equal(pool.endpoints.length, 2);
  assert.equal(pool.endpoints[1].model, 'deepseek-v4-pro');
  assert.equal(parseModelPool({ endpoints: [] }, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }), undefined);
  for (const bad of [
    { endpoints: [{ id: 'bad id', apiKey: 'sk-aaaaaaaa' }] },
    { endpoints: [{ id: 'a', apiKey: '' }] },
    { endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', weight: 0 }] },
    { endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', capabilities: ['unknown'] }] },
    { endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', apiKeyEnv: 'EMPTY' }] }
  ]) {
    assert.throws(() => parseModelPool(bad, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }));
  }
});

test('pool rotates, enforces concurrency and disables an exhausted key', () => {
  const pool = new CredentialPool(parseModelPool(config.modelPool, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }));
  const a = pool.select({ purpose: 'chat' });
  const second = pool.select({ purpose: 'chat' });
  assert.equal(a.endpointId, 'a');
  assert.equal(second.endpointId, 'b');
  assert.equal(pool.select({ purpose: 'chat' }), null, 'both endpoints are at maxConcurrent');
  a.report({ ok: false, status: 429 });
  assert.equal(second.endpointId, 'b');
  assert.equal(pool.status.find(item => item.id === 'a').cooldownUntil > Date.now(), true);
  second.report({ ok: false, status: 401 });
  assert.equal(pool.status.find(item => item.id === 'b').disabled, true);
  const next = pool.select({ purpose: 'chat' });
  assert.equal(next, null);
});

test('requestModelMessage fails over to the next endpoint and rewrites the model', async () => {
  const pool = new CredentialPool(parseModelPool(config.modelPool, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }));
  const credentials = pool.select({ purpose: 'chat' });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), model: body.model, auth: init.headers.Authorization });
    if (calls.length === 1) return new Response('', { status: 429 });
    return Response.json({ choices: [{ message: { content: '好' } }] });
  };
  try {
    const result = await requestModelMessage(
      { provider: 'deepseek-official', model: 'fallback', maxRequestBytes: 10000, budget: { enabled: false } },
      credentials,
      [{ role: 'user', content: '你好' }],
      [],
      new AbortController().signal
    );
    assert.equal(result.content, '好');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, 'deepseek-v4-flash');
    assert.equal(calls[1].model, 'deepseek-v4-pro');
    assert.notEqual(calls[0].auth, calls[1].auth);
  } finally {
    globalThis.fetch = original;
  }
});

test('pooled credentials are exposed to the bridge without losing the legacy fallback', () => {
  const pool = getCredentialPool(config);
  assert.ok(pool);
  const bridge = modelPoolForBridge(config);
  assert.equal(bridge.endpoints.length, 2);
  assert.equal(bridge.endpoints[0].model, 'deepseek-v4-flash');
});

test('config normalization and credential lookup use the pool', async () => {
  const normalized = resolveDSHConfig(config);
  assert.equal(normalized.modelPool.endpoints.length, 2);
  assert.throws(() => resolveDSHConfig({ ...config, modelPool: { endpoints: [{ id: 'a', apiKey: '' }] } }));
  const credential = await getDSHCredentials(config, { purpose: 'chat' });
  assert.equal(credential.endpointId, 'a');
  assert.equal(credential.model, 'deepseek-v4-flash');
  assert.equal(typeof credential.report, 'function');
  assert.equal(typeof credential.next, 'function');
});

test('direct chat also fails over and uses the selected model', async () => {
  const pool = new CredentialPool(parseModelPool(config.modelPool, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }));
  const credentials = pool.select({ purpose: 'chat' });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (calls.length === 1) return new Response('', { status: 429 });
    return Response.json({ choices: [{ message: { content: '到了' } }] });
  };
  try {
    const events = [];
    await directChat(
      {
        provider: 'deepseek-official',
        model: 'fallback',
        defaultSystemPrompt: 'persona',
        outputBlockedKeywords: [],
        inputBlockedKeywords: [],
        maxRequestBytes: 10000,
        budget: { enabled: false }
      },
      credentials,
      '你好',
      new AbortController().signal,
      async event => events.push(event)
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.model, 'deepseek-v4-pro');
    assert.ok(events.some(event => event.type === 'content' && event.content === '到了'));
  } finally {
    globalThis.fetch = original;
  }
});
