import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestSlotPool } from '../lib/dsh/request-slots.js';

test('silent continuation releases execution capacity and queues behind other work', async () => {
  const pool = new RequestSlotPool();
  const first = pool.acquire(1);
  const controller = new AbortController();
  let resumed = false;
  const waiting = pool.requeue(first, 1, controller.signal).then(release => {
    resumed = true;
    return release;
  });
  assert.equal(pool.active, 0);
  const other = pool.acquire(1);
  await delay(5);
  assert.equal(resumed, false);
  assert.equal(pool.active, 1);
  other();
  const release = await waiting;
  assert.equal(resumed, true);
  assert.equal(pool.active, 1);
  release();
  release();
  assert.equal(pool.active, 0);
});

test('cancelling a queued continuation removes it without leaking or later stealing a slot', async () => {
  const pool = new RequestSlotPool();
  const first = pool.acquire(1);
  const controller = new AbortController();
  const waiting = pool.requeue(first, 1, controller.signal);
  const other = pool.acquire(1);
  await delay(5);
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(pool.active, 1);
  other();
  assert.equal(pool.active, 0);
  const release = pool.acquire(1);
  release();
  assert.equal(pool.active, 0);
});

test('capacity returns to zero when cancellation happens before the continuation queues', async () => {
  const pool = new RequestSlotPool();
  const first = pool.acquire(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pool.requeue(first, 1, controller.signal));
  assert.equal(pool.active, 0);
});

test('queued continuations resume FIFO without exceeding capacity', async () => {
  const pool = new RequestSlotPool();
  const first = pool.acquire(2),
    second = pool.acquire(2);
  const order = [];
  const a = pool.requeue(first, 2, new AbortController().signal).then(release => {
    order.push('a');
    return release;
  });
  const b = pool.requeue(second, 2, new AbortController().signal).then(release => {
    order.push('b');
    return release;
  });
  const busy = pool.acquire(1);
  // Both continuation limits allow a second slot; one resumes, the other must wait.
  await delay(5);
  assert.deepEqual(order, ['a']);
  assert.equal(pool.active, 2);
  (await a)();
  const releaseB = await b;
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(pool.active, 2);
  busy();
  releaseB();
  assert.equal(pool.active, 0);
});
