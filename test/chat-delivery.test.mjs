import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultCode } from 'alemonjs';
import { StreamOutput, assertMessageDelivered } from '../lib/dsh/output.js';
import { enqueueChat, cancelChatForUser, cancelGroupChat } from '../lib/dsh/orchestrator.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};

test('resolved failure receipts and partial delivery never count as successful output', async () => {
  assert.doesNotThrow(() => assertMessageDelivered([{ code: ResultCode.Ok }]));
  for (const receipts of [undefined, [], [{ code: ResultCode.Fail }], [{ code: ResultCode.Ok }, { code: ResultCode.Fail }]]) {
    assert.throws(() => assertMessageDelivered(receipts));
  }
  const errors = [];
  let sends = 0;
  const output = new StreamOutput(
    async () => {
      sends++;
      if (sends === 2) assertMessageDelivered([{ code: ResultCode.Fail }]);
    },
    10,
    10000,
    error => errors.push(error)
  );
  output.append('第一段。');
  await output.flush();
  output.append('第二段。');
  assert.equal(await output.close(), false);
  assert.equal(errors.length, 1);
});

test('cancelling output discards buffered and queued tails, including late model chunks', async () => {
  const sent = [];
  const started = deferred();
  const receipt = deferred();
  const signal = new AbortController();
  const output = new StreamOutput(
    async text => {
      sent.push(text);
      started.resolve();
      await receipt.promise;
    },
    10,
    10000,
    assert.fail
  );
  output.bindSignal(signal.signal);
  output.append('第一段。');
  const flushing = output.flush();
  await started.promise;
  output.append('取消后不该发送');
  const queuedFlush = output.flush(true);
  signal.abort();
  output.append('迟到的模型文本');
  receipt.resolve();
  await Promise.all([flushing, queuedFlush]);
  assert.equal(await output.close(), false);
  assert.deepEqual(sent, ['第一段。']);
});

test('tiny message limits never produce oversized code wrappers or split emoji', async () => {
  const sent = [];
  const output = new StreamOutput(
    async text => {
      sent.push(text);
    },
    1,
    10000,
    assert.fail
  );
  output.append('🐋你好');
  assert.equal(await output.close(), true);
  assert.deepEqual(sent, ['🐋', '你', '好']);
});

test('zero queued requests allows the idle request but rejects concurrent requests', async () => {
  const hold = deferred();
  const started = deferred();
  const first = enqueueChat('queue-zero', 0, 'u', async () => {
    started.resolve();
    await hold.promise;
  });
  await started.promise;
  await assert.rejects(enqueueChat('queue-zero', 0, 'u', async () => {}));
  hold.resolve();
  await first;
  await enqueueChat('queue-zero', 0, 'u', async () => {});
});

test('queue holds the next turn until delivery finishes and reset cancels queued turns', async () => {
  const hold = deferred();
  const started = deferred();
  const order = [];
  const first = enqueueChat('delivery-order', 3, 'u', async () => {
    order.push('model');
    started.resolve();
    await hold.promise;
    order.push('delivery');
  });
  await started.promise;
  const second = enqueueChat('delivery-order', 3, 'u', async () => {
    order.push('next');
  });
  assert.deepEqual(order, ['model']);
  hold.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['model', 'delivery', 'next']);

  const running = deferred();
  const active = enqueueChat(
    'reset-order',
    3,
    'owner',
    signal =>
      new Promise(resolve => {
        running.resolve();
        signal.addEventListener('abort', resolve, { once: true });
      })
  );
  await running.promise;
  const queued = enqueueChat('reset-order', 3, 'other', async () => assert.fail('reset request ran'));
  const rejected = assert.rejects(queued, error => error.kind === 'cancelled');
  assert.equal(cancelChatForUser('reset-order', 'stranger', false), 'forbidden');
  cancelGroupChat('reset-order');
  await Promise.all([active, rejected]);
});
