import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadRuntime } from '../lib/dsh/runtime-download.js';

const bytes = Buffer.from('verified-runtime-fixture');
const hash = createHash('sha256').update(bytes).digest('hex');

test('transient server and interrupted body failures retry and verify final bytes', async () => {
  let calls = 0;
  const result = await downloadRuntime('https://example.invalid/runtime', hash, new AbortController().signal, async () => {
    calls++;
    if (calls === 1) return new Response('unavailable', { status: 503 });
    if (calls === 2)
      return new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error('connection reset'));
          }
        })
      );
    return new Response(bytes);
  });
  assert.equal(calls, 3);
  assert.deepEqual(result, bytes);
});

for (const [name, response, pattern] of [
  ['missing release', () => new Response('missing', { status: 404 }), /HTTP 404/],
  ['checksum mismatch', () => new Response('corrupt'), /checksum/],
  ['oversized response', () => new Response('x'.repeat(100)), /size limit/]
]) {
  test(`${name} fails without retrying or executing downloaded content`, async () => {
    let calls = 0;
    await assert.rejects(
      downloadRuntime(
        'https://example.invalid/runtime',
        hash,
        new AbortController().signal,
        async () => {
          calls++;
          return response();
        },
        50
      ),
      pattern
    );
    assert.equal(calls, 1);
  });
}

test('cancellation during retry stops subsequent network requests', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    downloadRuntime('https://example.invalid/runtime', hash, controller.signal, async () => {
      calls++;
      controller.abort();
      return new Response('', { status: 503 });
    }),
    /abort/i
  );
  assert.equal(calls, 1);
});
