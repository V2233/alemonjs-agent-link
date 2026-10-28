import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeByKey } from '../lib/dsh/serialize.js';

test('the same key never overlaps and keeps arrival order', async () => {
  const locks = new Map();
  const events = [];
  let active = 0;
  let maxActive = 0;
  const run = id =>
    serializeByKey(locks, 'same', async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${id}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push(`end:${id}`);
      active--;
      return id;
    });
  assert.deepEqual(await Promise.all([run(1), run(2), run(3)]), [1, 2, 3]);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
});

test('different keys stay concurrent', async () => {
  const locks = new Map();
  const started = [];
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const hold = key =>
    serializeByKey(locks, key, async () => {
      started.push(key);
      await gate;
    });
  const both = Promise.all([hold('x'), hold('y')]);
  await new Promise(resolve => setTimeout(resolve, 10));
  // Neither key waits on the other; both are inside their run at the same time.
  assert.deepEqual(started.toSorted(), ['x', 'y']);
  release();
  await both;
});

test('a burst of check-then-act callers performs the work exactly once', async () => {
  const locks = new Map();
  let isolated = false;
  let resets = 0;
  const ensure = () =>
    serializeByKey(locks, 'group', async () => {
      // Stand-in for the Redis round trips that made the old check race.
      await new Promise(resolve => setTimeout(resolve, 1));
      if (isolated) return;
      resets++;
      isolated = true;
    });
  await Promise.all(Array.from({ length: 20 }, ensure));
  assert.equal(resets, 1);
});

test('a failing run releases the key instead of wedging the queue', async () => {
  const locks = new Map();
  await assert.rejects(
    serializeByKey(locks, 'a', async () => Promise.reject(new Error('boom'))),
    /boom/u
  );
  assert.equal(await serializeByKey(locks, 'a', async () => 'ok'), 'ok');
});

test('drained keys are dropped from the map', async () => {
  const locks = new Map();
  await serializeByKey(locks, 'a', async () => 1);
  assert.equal(locks.size, 0);
});
