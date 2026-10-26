import test from 'node:test';
import assert from 'node:assert/strict';
import { abortFailure } from '../lib/dsh/errors.js';
import { runToolChat } from '../lib/agent/tool-chat.js';
import { streamChat, toUserMessage } from '../lib/dsh/client.js';
import { setDSHBridgeForTesting } from '../lib/dsh/supervisor.js';

const config = {
  model: 'test',
  provider: 'deepseek-official',
  defaultSystemPrompt: '',
  inputBlockedKeywords: [],
  maxRequestBytes: 10000,
  requestTimeoutMs: 1000
};

test('deadline expiration is a timeout while user cancellation remains cancellation', () => {
  assert.equal(abortFailure(new DOMException('deadline', 'TimeoutError')).kind, 'timeout');
  const cancel = new AbortController();
  cancel.abort();
  assert.equal(abortFailure(new Error('fetch failed'), cancel.signal).kind, 'cancelled');
  assert.equal(abortFailure(new Error('ordinary failure')), undefined);
  assert.match(toUserMessage(abortFailure(new DOMException('deadline', 'TimeoutError'))), /超时/);
});

test('stalled model requests report timeout without retrying or running tools', async () => {
  const oldFetch = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const timer = setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), 20);
  try {
    await assert.rejects(
      runToolChat({
        config,
        credentials: { apiKey: 'test' },
        input: 'hello',
        maxRounds: 2,
        context: { signal: controller.signal, userText: 'hello', requestId: 'timeout-test' },
        tools: [{ name: 'test_tool', description: 'test', parameters: { type: 'object' }, execute: async () => assert.fail('must not run') }]
      }),
      error => error.kind === 'timeout'
    );
    assert.equal(requests, 1);
  } finally {
    clearTimeout(timer);
    globalThis.fetch = oldFetch;
  }
});

test('sandbox transport preserves external deadline versus manual cancellation', async () => {
  const oldFetch = globalThis.fetch;
  setDSHBridgeForTesting({ url: 'http://test.invalid', token: 'test' });
  globalThis.fetch = async (_url, options) => {
    options.signal.throwIfAborted();
    throw new Error('unexpected request');
  };
  try {
    for (const [reason, kind] of [
      [new DOMException('deadline', 'TimeoutError'), 'timeout'],
      [new DOMException('cancel', 'AbortError'), 'cancelled']
    ]) {
      const controller = new AbortController();
      controller.abort(reason);
      await assert.rejects(
        streamChat(config, 'test', 'hello', async () => {}, 'user', controller.signal),
        error => error.kind === kind
      );
    }
  } finally {
    setDSHBridgeForTesting(null);
    globalThis.fetch = oldFetch;
  }
});
