import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultCode } from 'alemonjs';
import { QQStreamOutput, supportsQQStream } from '../lib/dsh/qq-stream.js';
import { readCompletionStream } from '../lib/dsh/completion-stream.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('QQ streaming is restricted to QQ official c2c private messages', () => {
  assert.equal(supportsQQStream({ Platform: 'qq-bot', IsPrivate: true, MessageId: 'm' }, true), true);
  for (const event of [
    { Platform: 'qq', IsPrivate: true, MessageId: 'm' },
    { Platform: 'qq-bot', IsPrivate: false, MessageId: 'm' },
    { Platform: 'qq-bot', IsPrivate: true },
    { Platform: 'qq-bot', IsPrivate: true, MessageId: 'm', Target: { scope: 'direct' } }
  ]) {
    assert.equal(supportsQQStream(event, true), false);
  }
});

test('model chunks reach the QQ stream before model completion; updates coalesce at adapter rate', async () => {
  const sends = [];
  let delivered;
  const output = new QQStreamOutput(
    async params => {
      sends.push({ at: Date.now(), ...params });
      return { code: ResultCode.Ok, data: { id: 'stream-id', remainingLength: 0 } };
    },
    'incoming',
    10000,
    async (receipt, text) => {
      delivered = { receipt, text };
    },
    async () => 3
  );
  const encoder = new TextEncoder();
  let controller;
  const response = new Response(
    new ReadableStream({
      start(value) {
        controller = value;
      }
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  );
  const reading = readCompletionStream(response, 10000, new AbortController().signal, async text => output.append(text));
  controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'));
  await sleep(30);
  assert.equal(sends.length, 1, 'first model delta must leave before upstream is closed');
  assert.equal(sends[0].state, 'generating');
  assert.equal(sends[0].contentType, 'text');
  assert.equal(sends[0].index, 0);
  controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"，"}}]}\n\ndata: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n'));
  await reading;
  assert.equal(await output.close(), true);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].state, 'complete');
  assert.equal(sends[1].text, '你好，世界');
  assert.equal(sends[1].streamId, 'stream-id');
  assert.equal(sends[1].index, 1);
  assert.deepEqual(
    sends.map(item => item.sequence),
    [3, 3]
  );
  assert.ok(sends[1].at - sends[0].at >= 480);
  assert.equal(delivered.text, '你好，世界');
});

test('cancel and failed receipts cannot be treated as a completed stream', async () => {
  let sends = 0,
    delivered = 0;
  const output = new QQStreamOutput(
    async () => {
      sends++;
      return { code: ResultCode.Fail, data: null };
    },
    'm',
    1000,
    async () => {
      delivered++;
    },
    async () => 1
  );
  output.append('hello');
  await sleep(20);
  assert.equal(await output.close(), false);
  assert.equal(delivered, 0);
  const cancelled = new QQStreamOutput(
    async () => {
      sends++;
      return { code: ResultCode.Ok, data: { id: 'x' } };
    },
    'm',
    1000,
    async () => {
      delivered++;
    },
    async () => 1
  );
  const controller = new AbortController();
  cancelled.bindSignal(controller.signal);
  cancelled.append('never sent');
  controller.abort();
  await sleep(20);
  assert.equal(sends, 1);
  assert.equal(await cancelled.close(), false);
});

test('SSE handles fragmented UTF-8 and tool arguments without leaking reasoning', async () => {
  const raw =
    'data: ' +
    JSON.stringify({
      choices: [
        { delta: { reasoning_content: 'secret', content: '鲸', tool_calls: [{ index: 0, id: 'call', function: { name: 'lookup', arguments: '{"a":' } }] } }
      ]
    }) +
    '\r\n\r\n' +
    'data: ' +
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }) +
    '\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(raw);
  const chunks = [];
  const result = await readCompletionStream(
    new Response(
      new ReadableStream({
        start(c) {
          for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
          c.close();
        }
      })
    ),
    10000,
    new AbortController().signal,
    async text => {
      chunks.push(text);
    }
  );
  assert.deepEqual(chunks, ['鲸']);
  assert.equal(result.tool_calls[0].function.arguments, '{"a":1}');
  await assert.rejects(
    readCompletionStream(new Response('data: {"choices":[]}\n\n'), 1000, new AbortController().signal, async () => {}),
    /未完整/
  );
});

test('tool-model request enables upstream SSE and forwards deltas before completion', async () => {
  const { requestModelMessage } = await import('../lib/agent/tool-chat.js');
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const original = globalThis.fetch;
  let controller;
  const chunks = [];
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(
      new ReadableStream({
        start(c) {
          controller = c;
        }
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    );
  };
  try {
    const task = requestModelMessage(
      getDSHConfig({}),
      { apiKey: 'test', model: 'test' },
      [{ role: 'user', content: 'hi' }],
      [],
      new AbortController().signal,
      async delta => {
        chunks.push(delta);
      }
    );
    await sleep(0);
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
    await sleep(0);
    assert.deepEqual(chunks, ['first']);
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" last"}}]}\n\ndata: [DONE]\n\n'));
    const result = await task;
    assert.equal(result.content, 'first last');
    assert.deepEqual(chunks, ['first', ' last']);
  } finally {
    globalThis.fetch = original;
  }
});

test('stream reserves the adapter sequence once and leaves the next sequence for ordinary replies', async () => {
  const { withEventContext } = await import('alemonjs');
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const { createQQSequenceAllocator } = await import('../lib/dsh/qq-stream.js');
  let sequence = 1; // An earlier reply already used sequence 1.
  let reservations = 0;
  const event = { name: 'private.message.create', Platform: 'qq-bot', BotId: 'bot-a', MessageId: 'incoming', IsPrivate: true };
  const scope = {
    resources: new Map(),
    cleanups: new Set(),
    disposed: false,
    now: Date.now,
    api: async request => {
      assert.equal(request.action, 'client.api');
      assert.equal(request.payload.event.BotId, 'bot-a');
      assert.equal(request.payload.key, 'getMessageSeq');
      assert.deepEqual(request.payload.params, ['incoming']);
      reservations++;
      return [{ code: ResultCode.Ok, data: ++sequence }];
    }
  };
  await runtimeScope.run(scope, () =>
    withEventContext(
      event,
      async () => {},
      async () => {
        const sends = [];
        const output = new QQStreamOutput(
          async params => {
            sends.push(params);
            return { code: ResultCode.Ok, data: { id: 'stream', remainingLength: 0 } };
          },
          'incoming',
          1000,
          async () => {},
          createQQSequenceAllocator('incoming')
        );
        output.append('在的在');
        await sleep(20);
        output.append('，有什么可以帮你？');
        assert.equal(await output.close(), true);
        assert.equal(reservations, 1);
        assert.deepEqual(
          sends.map(item => item.sequence),
          [2, 2]
        );
        assert.equal(++sequence, 3, 'ordinary replies get a different sequence from the same adapter counter');
      }
    )
  );
});
