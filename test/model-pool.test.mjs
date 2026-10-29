import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialPool, getCredentialPool, modelPoolForBridge } from '../lib/credentials/pool.js';
import { parseModelPool } from '../lib/model-pool/config.js';
import { requestModelMessage } from '../lib/agent/tool-chat.js';
import { getDSHCredentials } from '../lib/dsh/credentials.js';
import { directChat } from '../lib/dsh/direct-chat.js';
import { resolveReplyGateConnection } from '../lib/social/reply-gate.js';
import { resolveDSHConfig, runtimeSummary } from '../lib/dsh/config.js';

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
  const first = pool.select({ purpose: 'chat' });
  const second = pool.select({ purpose: 'chat' });

  assert.ok(first && second);
  assert.notEqual(first.endpointId, second.endpointId, 'both endpoints should be used before concurrency is exhausted');
  assert.equal(pool.select({ purpose: 'chat' }), null, 'both endpoints are at maxConcurrent');
  first.report({ ok: false, status: 429 });
  assert.equal(pool.status.find(item => item.id === first.endpointId).cooldownUntil > Date.now(), true);
  second.report({ ok: false, status: 401 });
  assert.equal(pool.status.find(item => item.id === second.endpointId).disabled, true);
  assert.equal(pool.select({ purpose: 'chat' }), null);
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
    assert.equal(new Set(calls.map(call => call.model)).size, 2);
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
  assert.ok(['a', 'b'].includes(credential.endpointId));
  assert.equal(credential.model, credential.endpointId === 'a' ? 'deepseek-v4-flash' : 'deepseek-v4-pro');
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
    assert.notEqual(calls[0].body.model, calls[1].body.model);
    assert.ok(events.some(event => event.type === 'content' && event.content === '到了'));
  } finally {
    globalThis.fetch = original;
  }
});

test('shorthand keys use the main api/model defaults and auto-generated ids', async () => {
  const simple = parseModelPool(
    { keys: ['sk-aaaaaaaa', 'sk-bbbbbbbb'] },
    { provider: 'deepseek-official', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' }
  );
  assert.equal(simple.endpoints.length, 2);
  assert.deepEqual(
    simple.endpoints.map(item => item.id),
    ['key-1', 'key-2']
  );
  assert.equal(simple.endpoints[0].model, 'deepseek-v4-flash');
  assert.equal(simple.endpoints[0].baseUrl, 'https://api.deepseek.com');
  const normalized = resolveDSHConfig({
    apiKey: 'sk-legacy-000000',
    model: 'deepseek-v4-flash',
    modelPool: { keys: ['sk-aaaaaaaa', 'sk-bbbbbbbb'] }
  });
  assert.equal(normalized.modelPool.endpoints.length, 2);
  const credential = await getDSHCredentials(normalized, { purpose: 'chat' });
  assert.equal(credential.endpointId, 'key-1');
});

test('OpenAI-compatible vendor endpoints use their own base URL and model', async () => {
  const vendor = {
    apiKey: 'sk-legacy-000000',
    model: 'deepseek-v4-flash',
    modelPool: {
      keys: [
        {
          key: 'sk-vendor-000000',
          api: 'https://openrouter.ai/api/v1',
          model: 'deepseek/deepseek-chat',
          pricing: { input: 2, output: 8, cached: 0.04 }
        }
      ]
    }
  };
  const credential = await getDSHCredentials(vendor, { purpose: 'chat' });
  assert.equal(credential.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(credential.model, 'deepseek/deepseek-chat');
  assert.deepEqual(credential.pricing, { input: 2, output: 8, cached: 0.04 });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
    return Response.json({ choices: [{ message: { content: '跨厂商' } }] });
  };
  try {
    const result = await requestModelMessage(
      { provider: 'deepseek-official', model: 'fallback', maxRequestBytes: 10000, budget: { enabled: false } },
      credential,
      [{ role: 'user', content: '你好' }],
      [],
      new AbortController().signal
    );
    assert.equal(result.content, '跨厂商');
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[0].body.model, 'deepseek/deepseek-chat');
    assert.equal(calls[0].auth, 'Bearer sk-vendor-000000');
  } finally {
    globalThis.fetch = original;
  }
});

test('bridge only receives endpoints with the matching sandbox provider', () => {
  const mixed = {
    apiKey: 'sk-legacy-000000',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    modelPool: {
      keys: [
        { id: 'ds', apiKey: 'sk-ds-000000', provider: 'deepseek-official' },
        { id: 'vendor', apiKey: 'sk-vendor-0000', provider: 'openai', baseUrl: 'https://api.openai.com/v1', pricing: { input: 1, output: 2 } }
      ]
    }
  };
  const bridge = modelPoolForBridge(mixed);
  assert.equal(bridge.endpoints.length, 1);
  assert.equal(bridge.endpoints[0].id, 'ds');
});

test('reply gate keeps the vendor model when it reuses a pooled endpoint', async () => {
  const vendor = {
    apiKey: 'sk-legacy-000000',
    model: 'deepseek-v4-flash',
    modelPool: { keys: [{ key: 'sk-vendor-000000', api: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' }] }
  };
  const credential = await getDSHCredentials(vendor, { purpose: 'replyGate' });
  const gate = resolveReplyGateConnection({ provider: 'deepseek-official', model: 'deepseek-v4-flash', groupWakeNames: [] }, credential);
  assert.equal(gate.model, 'deepseek/deepseek-chat');
  assert.equal(gate.baseUrl, 'https://openrouter.ai/api/v1');
});

test('startup probes discover dead keys before the first chat request', async () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        probeIntervalSeconds: 3600,
        endpoints: [
          { id: 'dead', apiKey: 'sk-dead-000000', baseUrl: 'https://dead.example', model: 'm' },
          { id: 'live', apiKey: 'sk-live-000000', baseUrl: 'https://live.example', model: 'm' }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('dead.example')) return new Response('', { status: 401 });
    return Response.json({ data: [] });
  };
  try {
    pool.startHealthMonitor();
    for (let index = 0; index < 30 && !pool.status.find(item => item.id === 'dead').disabled; index++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(pool.status.find(item => item.id === 'dead').disabled, true);
    assert.equal(pool.status.find(item => item.id === 'live').healthy, true);
  } finally {
    pool.stop();
    globalThis.fetch = original;
  }
});

test('Retry-After and exhausted rate-limit headers drive cooldown', async () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        maxAttempts: 1,
        endpoints: [
          { id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm' },
          { id: 'b', apiKey: 'sk-bbbbbbbb', model: 'm' }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const a = pool.select({ purpose: 'chat' });
  const firstId = a.endpointId;
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } });
  try {
    await requestModelMessage(
      { provider: 'deepseek-official', model: 'm', maxRequestBytes: 10000, budget: { enabled: false } },
      a,
      [{ role: 'user', content: 'x' }],
      [],
      new AbortController().signal
    );
  } catch {}
  const cooldown = pool.status.find(item => item.id === firstId).cooldownUntil;
  assert.ok(cooldown > Date.now() + 100000, 'Retry-After must win over the base cooldown');
  const b = pool.select({ purpose: 'chat' });
  assert.ok(b);
  assert.notEqual(b.endpointId, firstId);
  globalThis.fetch = async () => Response.json({ data: [] }, { headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '30' } });
  await requestModelMessage(
    { provider: 'deepseek-official', model: 'm', maxRequestBytes: 10000, budget: { enabled: false } },
    b,
    [{ role: 'user', content: 'x' }],
    [],
    new AbortController().signal
  ).catch(() => undefined);
  assert.ok(pool.status.find(item => item.id === b.endpointId).cooldownUntil > Date.now(), 'remaining=0 must cool the endpoint');
  globalThis.fetch = original;
});

test('auth-disabled endpoints recover through a later probe', async () => {
  let now = 1000000;
  const pool = new CredentialPool(
    parseModelPool(
      {
        recoveryProbeSeconds: 300,
        endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm' }]
      },
      { provider: 'deepseek-official', model: 'm' }
    ),
    () => now
  );
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 401 });
  try {
    await pool.probeNow();
    assert.equal(pool.status[0].disabled, true);
    assert.ok(pool.status[0].disabledUntil > now);
    now += 301000;
    globalThis.fetch = async () => Response.json({ data: [] });
    await pool.probeNow();
    assert.equal(pool.status[0].disabled, false);
    assert.equal(pool.status[0].healthy, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('parsing the same shorthand config twice does not mutate it into keys+endpoints', () => {
  const raw = { keys: ['sk-aaaaaaaa', 'sk-bbbbbbbb'] };
  parseModelPool(raw, { provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.equal(raw.endpoints, undefined);
  assert.doesNotThrow(() => parseModelPool(raw, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }));
});

test('a successful /models probe does not erase an active chat 429 cooldown', async () => {
  let now = 1000000;
  const pool = new CredentialPool(
    parseModelPool({ maxAttempts: 1, endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm' }] }, { provider: 'deepseek-official', model: 'm' }),
    () => now
  );
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 429 });
  try {
    const credential = pool.select({ purpose: 'chat' });
    await requestModelMessage(
      { provider: 'deepseek-official', model: 'm', maxRequestBytes: 10000, budget: { enabled: false } },
      credential,
      [{ role: 'user', content: 'x' }],
      [],
      new AbortController().signal
    ).catch(() => undefined);
    const cooldown = pool.status[0].cooldownUntil;
    assert.ok(cooldown > now);
    globalThis.fetch = async () => Response.json({ data: [] });
    await pool.probeNow();
    assert.equal(pool.status[0].cooldownUntil, cooldown);
  } finally {
    globalThis.fetch = original;
  }
});

test('a fallback endpoint is used only after primary endpoints are unavailable', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        endpoints: [
          { id: 'primary', apiKey: 'sk-primary-0000', model: 'm', maxConcurrent: 1 },
          { id: 'backup', apiKey: 'sk-backup-00000', model: 'm', fallback: true }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  assert.equal(pool.select({ purpose: 'chat' }).endpointId, 'primary');
  assert.equal(pool.select({ purpose: 'chat' }).endpointId, 'backup');
});

test('priority biases selection without starving higher-priority endpoints', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        strategy: 'balanced',
        endpoints: [
          { id: 'preferred', apiKey: 'sk-primary-0000', model: 'm', priority: 0, weight: 1, maxConcurrent: 2 },
          { id: 'second', apiKey: 'sk-second-00000', model: 'm', priority: 10, weight: 1, maxConcurrent: 2 }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const picks = [];

  for (let index = 0; index < 80; index++) {
    const credential = pool.select({ purpose: 'chat' });

    picks.push(credential.endpointId);
    credential.report({ ok: true });
  }
  assert.ok(picks.filter(id => id === 'preferred').length > picks.filter(id => id === 'second').length);
  assert.ok(picks.includes('preferred') && picks.includes('second'));
});

test('chat keeps its sticky endpoint while new chats balance by recent load', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        strategy: 'balanced',
        stickySeconds: 1800,
        balanceWindowSeconds: 300,
        endpoints: [
          { id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm', maxConcurrent: 2 },
          { id: 'b', apiKey: 'sk-bbbbbbbb', model: 'm', maxConcurrent: 2 }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const first = pool.select({ purpose: 'chat', stickyKey: 'chat-a' });

  assert.ok(first);
  first.report?.({ ok: true, status: 200 });
  const again = pool.select({ purpose: 'chat', stickyKey: 'chat-a' });

  assert.equal(again.endpointId, first.endpointId);
  again.report?.({ ok: true, status: 200 });
  const seen = new Set();

  for (let index = 0; index < 20; index++) {
    const credential = pool.select({ purpose: 'chat', stickyKey: `chat-${index}` });

    seen.add(credential.endpointId);
    credential.report?.({ ok: true, status: 200 });
  }
  assert.deepEqual([...seen].sort(), ['a', 'b']);
  assert.equal(pool.status.find(item => item.id === 'a').bound + pool.status.find(item => item.id === 'b').bound, 21);
});

test('a failed endpoint releases its chat bindings for rebalance', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        strategy: 'balanced',
        stickySeconds: 1800,
        endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm', maxConcurrent: 2 }]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const credential = pool.select({ purpose: 'chat', stickyKey: 'chat-a' });
  assert.equal(pool.status[0].bound, 1);
  credential.report?.({ ok: false, status: 500 });
  assert.equal(pool.status[0].bound, 0);
});

test('RPM, TPM and account counters gate admission before the provider 429s', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        endpoints: [
          { id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm', rpm: 10, tpm: 100, maxConcurrent: 2 },
          { id: 'b', apiKey: 'sk-bbbbbbbb', model: 'm', account: 'shared', rpm: 2, maxConcurrent: 2 },
          { id: 'c', apiKey: 'sk-cccccccc', model: 'm', account: 'shared', rpm: 2, maxConcurrent: 2 }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const first = pool.select({ purpose: 'chat', estimatedTokens: 60, exclude: new Set(['b', 'c']) });
  assert.ok(first);
  first.reportUsage?.({ prompt_tokens: 60, completion_tokens: 0 });
  assert.equal(pool.select({ purpose: 'chat', estimatedTokens: 60, exclude: new Set(['b', 'c']) }), null);
  const sharedOne = pool.select({ purpose: 'chat', estimatedTokens: 0, exclude: new Set(['a']) });
  const sharedTwo = pool.select({ purpose: 'chat', estimatedTokens: 0, exclude: new Set(['a']) });
  assert.deepEqual([sharedOne.endpointId, sharedTwo.endpointId].sort(), ['b', 'c']);
  assert.equal(pool.select({ purpose: 'chat', estimatedTokens: 0, exclude: new Set(['a']) }), null);
});

test('estimated tokens are reserved before a response settles', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm', tpm: 100, maxConcurrent: 2 }]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const first = pool.select({ purpose: 'chat', estimatedTokens: 60 });
  assert.equal(first.endpointId, 'a');
  assert.equal(pool.select({ purpose: 'chat', estimatedTokens: 60 }), null);
  first.report?.({ ok: true, status: 200 });
  assert.equal(pool.select({ purpose: 'chat', estimatedTokens: 60 })?.endpointId, 'a');
});

test('daily usage ledger survives a process-level pool reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-link-pool-'));
  const path = join(dir, 'metrics.json');
  const pool = new CredentialPool(
    parseModelPool({ endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm' }] }, { provider: 'deepseek-official', model: 'm' }),
    Date.now,
    path
  );
  try {
    const credential = pool.select({ purpose: 'chat' });
    credential.reportUsage?.({ prompt_tokens: 10, completion_tokens: 4 });
    await new Promise(resolve => setTimeout(resolve, 350));
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.a.requests, 1);
    assert.equal(stored.a.input, 10);
    const reloaded = new CredentialPool(
      parseModelPool({ endpoints: [{ id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm' }] }, { provider: 'deepseek-official', model: 'm' }),
      Date.now,
      path
    );
    assert.equal(reloaded.status[0].dailyRequests, 1);
    assert.equal(reloaded.status[0].dailyTokens, 14);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a busy primary can wait instead of immediately spending the fallback', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        queueMaxWaitMs: 1500,
        endpoints: [
          { id: 'primary', apiKey: 'sk-primary-0000', model: 'm', maxConcurrent: 1 },
          { id: 'backup', apiKey: 'sk-backup-00000', model: 'm', fallback: true }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const first = pool.select({ purpose: 'chat', waitForCapacity: true });
  assert.equal(first.endpointId, 'primary');
  assert.equal(pool.select({ purpose: 'chat', waitForCapacity: true }), null);
  first.report?.({ ok: true, status: 200 });
  assert.equal(pool.select({ purpose: 'chat', waitForCapacity: true }).endpointId, 'primary');
  assert.equal(pool.select({ purpose: 'chat' }).endpointId, 'backup');
});

test('a provider-specific 400 falls through to the fallback endpoint', async () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        endpoints: [
          { id: 'primary', apiKey: 'sk-primary-0000', model: 'primary-model', baseUrl: 'https://primary.example/v1' },
          { id: 'backup', apiKey: 'sk-backup-00000', model: 'backup-model', baseUrl: 'https://backup.example/v1', fallback: true }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes('primary.example')) return Response.json({ error: { message: 'bad tools' } }, { status: 400 });
    return Response.json({ choices: [{ message: { content: '兜底成功' } }] });
  };
  try {
    const credential = pool.select({ purpose: 'chat' });
    const result = await requestModelMessage(
      { provider: 'deepseek-official', model: 'm', maxRequestBytes: 10000, budget: { enabled: false } },
      credential,
      [{ role: 'user', content: '天气' }],
      [],
      new AbortController().signal
    );
    assert.equal(result.content, '兜底成功');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.model, 'backup-model');
  } finally {
    globalThis.fetch = original;
  }
});

test('an empty 200 response fails over to the next endpoint', async () => {
  const credentials = new CredentialPool(
    parseModelPool(
      {
        maxAttempts: 2,
        endpoints: [
          { id: 'a', apiKey: 'sk-aaaaaaaa', model: 'm' },
          { id: 'b', apiKey: 'sk-bbbbbbbb', model: 'm' }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  ).select({ purpose: 'chat' });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.push(1);
    return calls.length === 1 ? Response.json({}) : Response.json({ choices: [{ message: { content: '换节点成功' } }] });
  };
  try {
    const result = await requestModelMessage(
      { provider: 'deepseek-official', model: 'm', maxRequestBytes: 10000, budget: { enabled: false } },
      credentials,
      [{ role: 'user', content: 'x' }],
      [],
      new AbortController().signal
    );
    assert.equal(result.content, '换节点成功');
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('a frozen billing account is disabled and the next endpoint is tried', async () => {
  const credentials = new CredentialPool(
    parseModelPool(
      {
        maxAttempts: 2,
        endpoints: [
          { id: 'frozen', apiKey: 'sk-aaaaaaaa', model: 'm' },
          { id: 'live', apiKey: 'sk-bbbbbbbb', model: 'm' }
        ]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  ).select({ purpose: 'chat' });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.push(1);
    return calls.length === 1
      ? Response.json({ error: { message: '计费账户已被冻结' } }, { status: 400 })
      : Response.json({ choices: [{ message: { content: '活下来了' } }] });
  };
  try {
    const result = await requestModelMessage(
      { provider: 'deepseek-official', model: 'm', maxRequestBytes: 10000, budget: { enabled: false } },
      credentials,
      [{ role: 'user', content: 'x' }],
      [],
      new AbortController().signal
    );
    assert.equal(result.content, '活下来了');
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('startup chat probe disables a frozen billing account even when /models is healthy', async () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        probeChat: true,
        probeIntervalSeconds: 3600,
        endpoints: [{ id: 'frozen', apiKey: 'sk-aaaaaaaa', model: 'm' }]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const original = globalThis.fetch;
  globalThis.fetch = async url =>
    String(url).endsWith('/models') ? Response.json({ data: [] }) : Response.json({ error: { message: '计费账户已被冻结' } }, { status: 400 });
  try {
    pool.startHealthMonitor();
    for (let index = 0; index < 30 && !pool.status[0].disabled; index++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(pool.status[0].disabled, true);
  } finally {
    pool.stop();
    globalThis.fetch = original;
  }
});

test('a hanging endpoint is abandoned inside the retry budget and failed over', async () => {
  const pool = new CredentialPool(
    parseModelPool(
      { enabled: true, maxAttempts: 3, retryBudgetMs: 2000, endpoints: config.modelPool.endpoints },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    )
  );
  const credentials = pool.select({ purpose: 'chat' });
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) {
      // 第一个端点永远不回包，只能靠单次尝试超时打断。
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    return Response.json({ choices: [{ message: { content: '备用端点' } }] });
  };
  try {
    const started = Date.now();
    const result = await requestModelMessage(
      { provider: 'deepseek-official', model: 'fallback', maxRequestBytes: 10000, budget: { enabled: false } },
      credentials,
      [{ role: 'user', content: '你好' }],
      [],
      new AbortController().signal
    );

    assert.equal(result.content, '备用端点');
    assert.equal(calls.length, 2, '挂起的端点被执行超时打断后换到了备用端点');
    assert.ok(Date.now() - started < 5000, '不会等到外层请求超时');
  } finally {
    globalThis.fetch = original;
  }
});

test('when every endpoint hangs the error names the attempts instead of a bare timeout', async () => {
  const pool = new CredentialPool(
    parseModelPool(
      { enabled: true, maxAttempts: 2, retryBudgetMs: 1000, endpoints: config.modelPool.endpoints },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    )
  );
  const credentials = pool.select({ purpose: 'chat' });
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true });
    });
  try {
    await assert.rejects(
      requestModelMessage(
        { provider: 'deepseek-official', model: 'fallback', maxRequestBytes: 10000, budget: { enabled: false } },
        credentials,
        [{ role: 'user', content: '你好' }],
        [],
        new AbortController().signal
      ),
      error => /模型请求(超时|失败)/u.test(error.message) && /a|b/u.test(error.message)
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('real request latency demotes slow endpoints instead of just probe results', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        enabled: true,
        strategy: 'balanced',
        endpoints: [
          { id: 'slow', apiKey: 'sk-slow-000000', model: 'deepseek-v4-flash', weight: 1, maxConcurrent: 4 },
          { id: 'fast', apiKey: 'sk-fast-000000', model: 'deepseek-v4-flash', weight: 1, maxConcurrent: 4 }
        ]
      },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    )
  );
  // 两个端点都先跑一次，把真实耗时喂进去。
  for (let index = 0; index < 4; index++) {
    const credential = pool.select({ purpose: 'chat' });

    assert.ok(credential);
    credential.report({ ok: true, latencyMs: credential.endpointId === 'slow' ? 4000 : 80 });
  }
  const picks = [];

  for (let index = 0; index < 50; index++) {
    const credential = pool.select({ purpose: 'chat' });

    picks.push(credential.endpointId);
    credential.report({ ok: true, latencyMs: credential.endpointId === 'slow' ? 4000 : 80 });
  }
  assert.ok(picks.filter(id => id === 'fast').length >= 35, `慢端点应被降权，实际：${picks.join(',')}`);
});

test('stable selection prefers the measured fast endpoint instead of the first configured one', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        enabled: true,
        strategy: 'balanced',
        endpoints: [
          { id: 'slow', apiKey: 'sk-slow-111111', model: 'deepseek-v4-flash', weight: 1, maxConcurrent: 4 },
          { id: 'fast', apiKey: 'sk-fast-111111', model: 'deepseek-v4-flash', weight: 1, maxConcurrent: 4 }
        ]
      },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    )
  );
  for (const id of ['slow', 'fast']) {
    const credential = pool.select({ purpose: 'replyGate' });

    assert.ok(credential);
    credential.report({ ok: true, latencyMs: credential.endpointId === id ? (id === 'slow' ? 3500 : 120) : 0 });
  }
  // 再喂两轮，让两个端点的延迟都稳定下来。
  for (let index = 0; index < 3; index++) {
    const credential = pool.select({ purpose: 'replyGate' });

    credential.report({ ok: true, latencyMs: credential.endpointId === 'slow' ? 3500 : 120 });
  }
  const stable = [];

  for (let index = 0; index < 3; index++) {
    const credential = pool.select({ purpose: 'replyGate', stable: true });

    stable.push(credential.endpointId);
    credential.report({ ok: true, latencyMs: credential.endpointId === 'slow' ? 3500 : 120 });
  }
  assert.deepEqual(stable, ['fast', 'fast', 'fast']);
});

test('a sticky session stays on its endpoint even when it turns out much slower', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        enabled: true,
        strategy: 'balanced',
        stickySeconds: 1800,
        endpoints: [
          { id: 'a', apiKey: 'sk-aaaa-222222', model: 'deepseek-v4-flash', weight: 1, maxConcurrent: 4 },
          { id: 'b', apiKey: 'sk-bbbb-222222', model: 'deepseek-v4-flash', weight: 1, maxConcurrent: 4 }
        ]
      },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    )
  );
  const bind = purpose => {
    const credential = pool.select({ purpose, stickyKey: 'group-1' });
    return credential;
  };
  const first = bind('chat');
  const slow = first.endpointId;
  const fast = slow === 'a' ? 'b' : 'a';

  // 两个端点都建立真实延迟：一个 4 秒，一个 80 毫秒。
  for (const id of [slow, fast]) {
    for (let index = 0; index < 3; index++) {
      const warm = pool.select({ purpose: 'chat', stickyKey: `warm-${id}-${index}` });

      warm.report({ ok: true, latencyMs: warm.endpointId === slow ? 4000 : 80 });
    }
  }
  first.report({ ok: true, latencyMs: 4000 });
  const again = bind('chat');

  assert.equal(again.endpointId, slow, '粘性绑定不应因为变慢而随意切换');
  again.report({ ok: true, latencyMs: 80 });
  assert.equal(bind('chat').endpointId, slow);
});

test('startup capability probes discover vision and tools instead of trusting config', async () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        probeChat: true,
        capabilityProbe: true,
        probeIntervalSeconds: 3600,
        endpoints: [{ id: 'probe', apiKey: 'sk-aaaaaaaa', model: 'm', capabilities: ['chat'], maxConcurrent: 2 }]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({ data: [] });
    const body = JSON.parse(init.body);
    if (Array.isArray(body.messages?.[0]?.content)) return Response.json({ choices: [{ message: { content: '红色' } }] });
    if (body.tools)
      return Response.json({ choices: [{ message: { tool_calls: [{ id: 'p', type: 'function', function: { name: 'probe_value', arguments: '{}' } }] } }] });
    return Response.json({ choices: [{ message: { content: '好' } }] });
  };
  try {
    pool.startHealthMonitor();
    for (let index = 0; index < 50 && !pool.status[0].capabilityProbed; index++) await new Promise(resolve => setTimeout(resolve, 10));
    const status = pool.status[0];
    assert.ok(status.verified.includes('vision'));
    assert.ok(status.verified.includes('tools'));
    assert.ok(status.capabilities.includes('vision'));
    assert.ok(status.capabilities.includes('tools'));
  } finally {
    pool.stop();
    globalThis.fetch = original;
  }
});

test('a configured vision capability is removed after a real image rejection', async () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        probeChat: true,
        capabilityProbe: true,
        probeIntervalSeconds: 3600,
        endpoints: [{ id: 'vision', apiKey: 'sk-aaaaaaaa', model: 'm', capabilities: ['chat', 'vision'], maxConcurrent: 2 }]
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (!init?.body) return Response.json({ data: [] });
    const body = JSON.parse(init.body);
    if (Array.isArray(body.messages?.[0]?.content)) return Response.json({ error: { message: 'unsupported image' } }, { status: 400 });
    if (body.tools) return Response.json({ choices: [{ message: { content: 'no tool' } }] });
    return Response.json({ choices: [{ message: { content: '好' } }] });
  };
  try {
    pool.startHealthMonitor();
    for (let index = 0; index < 50 && !pool.status[0].capabilityProbed; index++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pool.status[0].capabilities.includes('vision'), false);
    assert.equal(pool.select({ purpose: 'vision' }), null);
  } finally {
    pool.stop();
    globalThis.fetch = original;
  }
});

test('runtime summary shows the backend and pool models the process really uses', () => {
  const summary = runtimeSummary(
    resolveDSHConfig({
      ...config,
      stateBackend: 'redis',
      modelPool: {
        enabled: true,
        endpoints: [
          { id: 'a', apiKey: 'sk-aaaaaaaa', model: 'deepseek-flash', weight: 1, maxConcurrent: 1 },
          { id: 'b', apiKey: 'sk-bbbbbbbb', model: 'Sage-A1.5', weight: 1, maxConcurrent: 1, enabled: false }
        ]
      }
    })
  );
  // The disabled endpoint is reported in the total but never as an active model.
  assert.equal(summary.stateBackend, 'redis');
  assert.equal(summary.poolEnabled, true);
  assert.equal(summary.poolEndpoints, '1/2');
  assert.deepEqual(summary.poolModels, ['deepseek-flash']);
});

test('replyGate-only endpoint is not promoted to chat by successful capability probes', async () => {
  const pool = new CredentialPool(parseModelPool({
    probeChat:true, capabilityProbe:true,probeIntervalSeconds:0,
    endpoints:[{id:'gate-only',apiKey:'gate-private-key',model:'test',capabilities:['replyGate'],maxConcurrent:5}]
  },{provider:'test',baseUrl:'https://gate.example',model:'test'}));
  const previous=globalThis.fetch;
  globalThis.fetch=async (_url,init)=>{
    if(!init?.body)return Response.json({data:[]});
    const body=JSON.parse(init.body);
    return Response.json({choices:[{message:body.tools?{tool_calls:[{id:'p',type:'function',function:{name:'probe_value',arguments:'{}'}}]}:{content:'OK'}}]});
  };
  try{
    await pool.probeEndpoint('gate-only',true);
    assert.deepEqual(pool.status[0].capabilities,['replyGate']);
    assert.equal(pool.select({purpose:'chat'}),null);
    assert.equal(pool.select({purpose:'tools'}),null);
    assert.equal(pool.select({purpose:'vision'}),null);
    const gate=pool.select({purpose:'replyGate'});
    assert.equal(gate.endpointId,'gate-only');
    gate.report({ok:true,status:200});
    await pool.healthCheckEndpoint('gate-only');
    assert.deepEqual(pool.status[0].capabilities,['replyGate']);
    assert.equal(pool.select({purpose:'chat'}),null);
  }finally{globalThis.fetch=previous;pool.stop();}
});
