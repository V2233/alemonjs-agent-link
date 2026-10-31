import test from 'node:test';
import assert from 'node:assert/strict';
import { readBounded, MediaHttpError } from '../lib/media/http.js';

test('HTTP status survives a failing response cleanup', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() {
      cancelled = true;
      throw new Error('cleanup failed');
    }
  }), { status: 429 });
  await assert.rejects(readBounded(response, 4), error => error instanceof MediaHttpError && error.status === 429);
  assert.equal(cancelled, true);
});

test('oversized response stays a size error and releases its reader even when cancellation fails', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5)); },
    cancel() {
      cancelled = true;
      throw new Error('cleanup failed');
    }
  }));
  await assert.rejects(readBounded(response, 4), /响应超过限制/);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test('read failure is preserved and the reader is released', async () => {
  const failure = new Error('original read failure');
  const response = new Response(new ReadableStream({
    start(controller) { controller.error(failure); }
  }));
  await assert.rejects(readBounded(response, 4), error => error === failure);
  assert.equal(response.body.locked, false);
});

test('successful reads retain exact bytes and release the reader', async () => {
  const response = new Response('1234');
  assert.deepEqual(await readBounded(response, 4), Buffer.from('1234'));
  assert.equal(response.body.locked, false);
});
