import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialPool } from '../lib/credentials/pool.js';
import { parseModelPool } from '../lib/model-pool/config.js';
const make = (ids = ['a', 'b']) =>
  new CredentialPool(
    parseModelPool(
      {
        strategy: 'balanced',
        endpoints: ids.map(id => ({
          id,
          apiKey: 'sk-' + id + '-12345678',
          model: 'm',
          maxConcurrent: 2,
          capabilities: ['chat', 'tools'],
          weight: id === 'a' ? 1 : 100
        }))
      },
      { provider: 'deepseek-official', model: 'm' }
    )
  );
test('least active tasks, array ties, tool rounds pin without double reserving, close exactly once', () => {
  const pool = make();
  const a = pool.select({ purpose: 'tools' });
  a.hold();
  a.report({ ok: true });
  assert.equal(pool.status[0].active, 1);
  const b = pool.select({ purpose: 'chat' });
  assert.equal(b.endpointId, 'b');
  const again = a.renew(12);
  assert.equal(again.endpointId, 'a');
  assert.equal(pool.status[0].active, 1);
  again.report({ ok: true });
  assert.equal(pool.status[0].active, 1);
  a.endTask();
  a.endTask();
  b.report({ ok: true });
  assert.deepEqual(
    pool.status.map(s => s.active),
    [0, 0]
  );
});
test('reloading and removal/re-addition preserve occupied capacity and old credential snapshot', () => {
  const old = make();
  const lease = old.select();
  lease.hold();
  lease.report({ ok: true });
  const next = make(['b']);
  next.inheritRuntime(old);
  const latest = make(['b', 'a']);
  latest.inheritRuntime(next);
  assert.equal(latest.status.find(s => s.id === 'a').active, 1);
  const renewed = lease.renew(0);
  assert.equal(renewed.endpointId, 'a');
  renewed.report({ ok: true });
  lease.endTask();
  assert.equal(latest.status.find(s => s.id === 'a').active, 0);
});
test('bound task fails admission rather than migrate when its endpoint cools down', () => {
  const pool = make();
  const lease = pool.select();
  lease.hold();
  lease.report({ ok: false, status: 429 });
  assert.equal(lease.renew(0), null);
  lease.endTask();
  assert.equal(pool.status[0].active, 0);
});

test('task factory keeps the same endpoint across rounds and disables transparent retries', async () => {
  const { createChatTaskCredentials, getSandboxCredentials } = await import('../lib/dsh/credentials.js');
  const { getCredentialPool, stopCredentialPool } = await import('../lib/credentials/pool.js');
  const root = await mkdtemp(join(tmpdir(), 'task-balancing-'));
  const previous = globalThis.__config;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        dshHomeRoot: join(root, 'homes'),
        apiKey: 'legacy-must-not-bypass-capacity',
        modelPool: {
          probeIntervalSeconds: 0,
          endpoints: ['lease-a', 'lease-b'].map(id => ({
            id,
            apiKey: 'sk-123456789',
            baseUrl: 'https://example.com',
            model: 'm',
            capabilities: ['chat'],
            tpm: 10,
            maxConcurrent: 1
          }))
        }
      }
    }
  };
  const task = createChatTaskCredentials();
  try {
    const first = await task.acquire({ purpose: 'chat' });
    assert.equal(typeof first.next, 'function');
    first.report({ ok: true });
    assert.equal(first.next(), null);
    const pool = getCredentialPool(globalThis.__config.value['alemonjs-agent-link']);
    const other = pool.select();
    assert.equal(other.endpointId, 'lease-b');
    assert.equal(await getSandboxCredentials(true), null);
    const second = await task.acquire({ purpose: 'chat', estimatedTokens: 10 });
    assert.equal(second.endpointId, first.endpointId);
    // Closing during an unreported round releases its token reservation as well.
    task.close();
    assert.equal(pool.select({ reserve: false, estimatedTokens: 10 }).endpointId, first.endpointId);
    other.report({ ok: true });
    assert.deepEqual(
      pool.status.map(s => s.active),
      [0, 0]
    );
    await assert.rejects(task.acquire({ purpose: 'chat' }));
  } finally {
    task.close();
    stopCredentialPool();
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('late success preserves concurrent cooldown, auth disable and operator stop', () => {
  for (const failure of [429, 401, 'operator']) {
    const pool = make(['a']);
    const early = pool.select();
    const late = pool.select();
    if (failure === 'operator') {
      pool.setEndpointEnabled('a', false);
      early.report({ ok: false, errorKind: 'cancelled' });
    } else early.report({ ok: false, status: failure });
    const before = pool.status[0];
    late.report({ ok: true });
    assert.equal(pool.select(), null, String(failure));
    assert.equal(pool.status[0].cooldownUntil, before.cooldownUntil);
    assert.equal(pool.status[0].active, 0);
  }
});

test('queue expiry admits fallback; closing a waiting task cancels allocation', async () => {
  const { getChatCredentials, createChatTaskCredentials } = await import('../lib/dsh/credentials.js');
  const { getCredentialPool, stopCredentialPool } = await import('../lib/credentials/pool.js');
  const root = await mkdtemp(join(tmpdir(), 'task-balancing-'));
  const previous = globalThis.__config;
  const config = {
    dshHomeRoot: join(root, 'homes'),
    modelPool: {
      queueMaxWaitMs: 60,
      probeIntervalSeconds: 0,
      endpoints: ['primary', 'backup'].map(id => ({
        id,
        apiKey: 'sk-123456789',
        model: 'm',
        maxConcurrent: 1,
        fallback: id === 'backup',
        capabilities: ['chat']
      }))
    }
  };
  globalThis.__config = { value: { 'alemonjs-agent-link': config } };
  const pool = getCredentialPool(config);
  const busy = pool.select();
  const task = createChatTaskCredentials();
  try {
    const pending = task.acquire({ purpose: 'chat' });
    const rejected = assert.rejects(pending);
    await assert.rejects(task.acquire({ purpose: 'chat' }), /并发/);
    task.close();
    await rejected;
    assert.deepEqual(
      pool.status.map(s => s.active),
      [1, 0]
    );
    const fallback = await getChatCredentials({ purpose: 'chat' });
    assert.equal(fallback.endpointId, 'backup');
    fallback.report({ ok: true });
    busy.report({ ok: true });
    const fastTask = createChatTaskCredentials();
    const immediate = fastTask.acquire({ purpose: 'chat' });
    fastTask.close();
    await assert.rejects(immediate);
    assert.deepEqual(
      pool.status.map(s => s.active),
      [0, 0]
    );
  } finally {
    task.close();
    busy.report({ ok: true });
    stopCredentialPool();
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('old in-flight failure remains visible after reload without accessor chains', () => {
  for (const status of [429, 401]) {
    const old = make(['a']);
    const inFlight = old.select();
    let latest = old;
    for (let i = 0; i < 100; i += 1) {
      const next = make(['a']);
      next.inheritRuntime(latest);
      latest = next;
    }
    inFlight.report({ ok: false, status });
    assert.equal(latest.select(), null);
    assert.equal(latest.status[0].active, 0);
    assert.equal(latest.status[0].cooldownUntil, old.status[0].cooldownUntil);
  }
});

test('a probe started before an operator stop cannot re-enable the endpoint', async () => {
  const original = globalThis.fetch;
  const pool = make(['a']);
  let resolveResponse;
  globalThis.fetch = () =>
    new Promise(resolve => {
      resolveResponse = resolve;
    });
  try {
    const pending = pool.probeNow();
    pool.setEndpointEnabled('a', false);
    resolveResponse(Response.json({ data: [] }));
    await pending;
    assert.equal(pool.select(), null);
  } finally {
    globalThis.fetch = original;
    pool.stop();
  }
});
