import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatTaskCredentials } from '../lib/dsh/credentials.js';
import { getCredentialPool, stopCredentialPool } from '../lib/credentials/pool.js';
import { requestModelMessage } from '../lib/agent/tool-chat.js';

const config = { provider: 'deepseek-official', model: 'default', maxRequestBytes: 10000, budget: { enabled: false } };
const messages = [{ role: 'user', content: 'hello' }];
const success = () => Response.json({ choices: [{ message: { content: 'ok' } }] });
async function fixture(run, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'initial-failover-'));
  const savedConfig = globalThis.__config;
  const savedFetch = globalThis.fetch;
  const app = {
    dshHomeRoot: join(root, 'homes'),
    modelPool: {
      probeIntervalSeconds: 0,
      retryJitterMs: 0,
      maxAttempts: 3,
      retryBudgetMs: 1000,
      ...extra,
      endpoints: ['a', 'b', 'c'].map(id => ({ id, apiKey: `sk-${id}-12345678`, model: id, maxConcurrent: 1, capabilities: ['chat', 'tools'] }))
    }
  };
  globalThis.__config = { value: { 'alemonjs-agent-link': app } };
  const task = createChatTaskCredentials();
  const pool = getCredentialPool(app);
  try {
    await run(task, pool);
  } finally {
    task.close();
    assert.deepEqual(
      pool.status.map(s => s.active),
      [0, 0, 0]
    );
    stopCredentialPool();
    globalThis.__config = savedConfig;
    globalThis.fetch = savedFetch;
    await rm(root, { recursive: true, force: true });
  }
}

test('initial failures notify once across multiple switches, then later rounds stay on the successful endpoint', async () => {
  await fixture(async (task, pool) => {
    const calls = [];
    let retries = 0;
    globalThis.fetch = async (_, init) => {
      calls.push(JSON.parse(init.body).model);
      if (calls.length === 1) throw new TypeError('fetch failed');
      if (calls.length === 2) return Response.json({ error: { message: 'upstream unavailable' } }, { status: 502 });
      return success();
    };
    const first = await task.acquire({ purpose: 'chat' });
    const reply = await requestModelMessage(config, first, messages, [], new AbortController().signal, undefined, {
      onRetry: async () => {
        retries++;
      }
    });
    assert.equal(reply.content, 'ok');
    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.equal(retries, 1);
    assert.deepEqual(
      pool.status.map(s => s.active),
      [0, 0, 1]
    );
    const second = await task.acquire({ purpose: 'chat' });
    assert.equal(second.endpointId, 'c');
    assert.equal(second.next, undefined);
    globalThis.fetch = async () => {
      calls.push('later');
      return new Response('', { status: 502 });
    };
    await assert.rejects(requestModelMessage(config, second, messages, [], new AbortController().signal), /502/);
    assert.deepEqual(calls, ['a', 'b', 'c', 'later']);
  });
});

test('initial retries stop at the configured attempt limit', async () => {
  await fixture(
    async task => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response('', { status: 503 });
      };
      await assert.rejects(requestModelMessage(config, await task.acquire({ purpose: 'chat' }), messages, [], new AbortController().signal), /503/);
      assert.equal(calls, 2);
    },
    { maxAttempts: 2 }
  );
});

test('timeout leaves budget for a different endpoint', async () => {
  await fixture(async task => {
    let calls = 0;
    globalThis.fetch = async (_, init) => {
      if (++calls > 1) return success();
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    };
    const reply = await requestModelMessage(config, await task.acquire({ purpose: 'chat' }), messages, [], new AbortController().signal);
    assert.equal(reply.content, 'ok');
    assert.equal(calls, 2);
  });
});

test('parameter errors and cancellation never switch endpoints', async () => {
  for (const status of [400, 'cancel'])
    await fixture(async task => {
      let calls = 0;
      const controller = new AbortController();
      globalThis.fetch = async () => {
        calls++;
        if (status === 'cancel') {
          controller.abort();
          throw controller.signal.reason;
        }
        return Response.json({ error: { message: 'invalid parameter' } }, { status });
      };
      await assert.rejects(requestModelMessage(config, await task.acquire({ purpose: 'chat' }), messages, [], controller.signal));
      assert.equal(calls, 1);
    });
});

test('partial streamed output prevents failover', async () => {
  await fixture(async task => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"failed"}}\n\n', {
        headers: { 'content-type': 'text/event-stream' }
      });
    };
    const output = [];
    await assert.rejects(
      requestModelMessage(config, await task.acquire({ purpose: 'chat' }), messages, [], new AbortController().signal, async text => {
        output.push(text);
      })
    );
    assert.deepEqual(output, ['partial']);
    assert.equal(calls, 1);
  });
});

test('a stream error before any content can fail over', async () => {
  await fixture(async task => {
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls > 1) return success();
      return new Response('data: {"error":{"message":"unavailable"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const output = [];
    await requestModelMessage(config, await task.acquire({ purpose: 'chat' }), messages, [], new AbortController().signal, async text => {
      output.push(text);
    });
    assert.deepEqual(output, ['ok']);
    assert.equal(calls, 2);
  });
});

test('total budget exhaustion does not reserve another endpoint', async () => {
  await fixture(async (task, pool) => {
    let calls = 0;
    const selected = await task.acquire({ purpose: 'chat' });
    // Reach the deadline while the first response is returned.
    globalThis.fetch = async () => {
      calls++;
      selected.startedAt = Date.now() - 2000;
      return new Response('', { status: 502 });
    };
    await assert.rejects(requestModelMessage(config, selected, messages, [], new AbortController().signal), /502/);
    assert.equal(calls, 1);
    assert.deepEqual(
      pool.status.map(s => s.active),
      [1, 0, 0]
    );
  });
});
