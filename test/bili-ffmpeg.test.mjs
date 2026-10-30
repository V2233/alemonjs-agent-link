import test from 'node:test';
import assert from 'node:assert/strict';
import { createFfmpegAvailability } from '../lib/bili/ffmpeg.js';

test('concurrent ffmpeg checks share one bounded invocation, including manual refresh', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const available = createFfmpegAvailability(async () => { calls++; return gate; });
  const first = available(), second = available(true);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release(false);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await available(), false);
  assert.equal(calls, 1);
});

test('missing ffmpeg is cached for a minute and manual diagnostics immediately refresh installed tools', async () => {
  let calls = 0, time = 1000, installed = false;
  const available = createFfmpegAvailability(async () => { calls++; return installed; }, () => time);
  assert.equal(await available(), false);
  installed = true;
  time += 59999;
  assert.equal(await available(), false);
  assert.equal(calls, 1);
  assert.equal(await available(true), true);
  assert.equal(calls, 2);
  time += 60000;
  assert.equal(await available(), true);
  assert.equal(calls, 3);
});

test('failed checks are cached as unavailable and a backwards clock does not keep stale availability', async () => {
  let calls = 0, time = 1000;
  const available = createFfmpegAvailability(async () => { calls++; if (calls === 1) throw new Error('ENOENT'); return true; }, () => time);
  assert.equal(await available(), false);
  assert.equal(await available(), false);
  assert.equal(calls, 1);
  time--;
  assert.equal(await available(), true);
  assert.equal(calls, 2);
});
