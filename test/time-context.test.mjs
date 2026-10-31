import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTimeContext } from '../lib/dsh/time-context.js';
import { requestModelMessage } from '../lib/agent/tool-chat.js';

test('Beijing clock distinguishes late-night history from the next morning independent of host timezone', () => {
  assert.match(currentTimeContext(Date.parse('2026-10-30T17:00:00Z')), /2026\/10\/31 01:00:00/);
  const morning = currentTimeContext(Date.parse('2026-10-31T02:00:00Z'));
  assert.match(morning, /2026\/10\/31 10:00:00/);
  assert.match(morning, /历史对话/);
  assert.match(morning, /不能当作现在/);
});

test('each model request carries fresh time after old conversation context', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let sent;
  Date.now = () => Date.parse('2026-10-31T02:00:00Z');
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '早呀，睡得怎么样？' } }] }), { headers: { 'content-type': 'application/json' } });
  };
  const history = [
    { role: 'user', content: '凌晨了，晚安' },
    { role: 'assistant', content: '晚安' },
    { role: 'user', content: '起床啦' }
  ];
  try {
    await requestModelMessage(
      { model: 'test', provider: 'test', maxRequestBytes: 10000, budget: { enabled: false } },
      { apiKey: 'test', baseUrl: 'https://model.test' },
      history,
      [],
      new AbortController().signal
    );
    assert.deepEqual(sent.messages.slice(0, -1), history);
    assert.equal(sent.messages.at(-1).role, 'system');
    assert.match(sent.messages.at(-1).content, /10:00:00/);
    assert.equal(history.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
