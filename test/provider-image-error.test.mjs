import test from 'node:test';
import assert from 'node:assert/strict';
import { providerImageError } from '../lib/dsh/provider-error.js';
import { toUserMessage } from '../lib/dsh/client.js';
import { isFailureReply } from '../lib/dsh/failure-reply.js';
import { requestModelMessage } from '../lib/agent/tool-chat.js';

test('recognizes nested image diagnostics without treating all 400 failures as images', () => {
  const diagnostic = JSON.stringify({
    error: {
      message: JSON.stringify({ code: 11135, msg: 'Please start a new conversation, replace the image, and try again.', retry_policy: { retry: false } })
    }
  });
  const failure = providerImageError(400, diagnostic);
  assert.equal(failure.kind, 'media');
  assert.equal(toUserMessage(failure), '这张图我没认出来，换一张试试，或者用文字告诉我吧。');
  assert.equal(isFailureReply(toUserMessage(failure)), true);
  assert.equal(providerImageError(400, 'invalid tool schema'), undefined);
  assert.equal(providerImageError(500, diagnostic), undefined);
});

test('image rejection reaches the user as media failure without replaying or invoking tools', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: { message: JSON.stringify({ code: 11135, msg: 'Image not recognized. Please use another image and retry', retry_policy: { retry: false } }) }
      }),
      { status: 400 }
    );
  };
  try {
    await assert.rejects(
      requestModelMessage(
        { model: 'test', provider: 'test', maxRequestBytes: 10000, budget: { enabled: false } },
        {
          apiKey: 'test',
          baseUrl: 'https://model.test',
          initialFailover: true,
          next: () => {
            throw new Error('must not retry');
          }
        },
        [{ role: 'user', content: 'describe image' }],
        [],
        new AbortController().signal
      ),
      error => error.kind === 'media'
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
