import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyVerdict } from '../lib/social/reply-gate.js';

test('only strict boolean and consistent enumerated reason can admit a reply', () => {
  assert.deepEqual(parseReplyVerdict('{"reply":true,"reason":"follow_up","source":"unknown","loopRisk":false}'), {
    reply: true,
    reason: 'follow_up',
    source: 'unknown',
    loopRisk: false
  });
  for (const input of [
    'true',
    '```json\n{"reply":true,"reason":"direct_call"}\n```',
    '{"reply":"true","reason":"support"}',
    '{"reply":true,"reason":"none"}',
    '{"reply":false,"reason":"direct_call"}',
    '{"reply":true,"reason":"anything"}',
    '{"reply":true,"reason":"support","command":"run"}',
    'null'
  ]) {
    assert.deepEqual(parseReplyVerdict(input), { reply: false, reason: 'none' });
  }
});

test('one-shot classifier uses main credentials, bounded context, no tools, and fails closed', async () => {
  const { classifyGroupReply } = await import('../lib/social/reply-gate.js');
  const config = globalThis.__config,
    oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { apiKey: 'test-gate-key', model: 'test-gate-model' } } };
  const input = {
    recent: [{ speaker: 'bot', text: '你想查哪里？' }],
    messages: [{ speaker: 'u1', text: '杭州'.repeat(1000), called: false, media: ['image'] }]
  };
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-gate-model');
      assert.equal(body.tools, undefined);
      assert.equal(body.messages.length, 2);
      assert.equal(JSON.parse(body.messages[1].content).messages[0].text.length, 600);
      assert.equal(options.headers.Authorization, 'Bearer test-gate-key');
      return Response.json({ choices: [{ message: { content: '{"reply":true,"reason":"follow_up","source":"unknown","loopRisk":false}' } }] });
    };
    assert.deepEqual(await classifyGroupReply(input, new AbortController().signal), { reply: true, reason: 'follow_up', source: 'unknown', loopRisk: false });
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    assert.deepEqual(await classifyGroupReply(input, new AbortController().signal), { reply: false, reason: 'none' });
    const abort = new AbortController();
    abort.abort();
    globalThis.fetch = async () => assert.fail('aborted classifier must not send');
    assert.deepEqual(await classifyGroupReply(input, abort.signal), { reply: false, reason: 'none' });
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__config = config;
  }
});

test('automation and loop assessments veto positive replies; unknown source is not a bot label', () => {
  for (const verdict of [
    { reply: true, reason: 'direct_call', source: 'automated', loopRisk: false },
    { reply: true, reason: 'follow_up', source: 'human', loopRisk: true },
    { reply: true, reason: 'support', source: 'unknown' },
    { reply: true, reason: 'support', source: 'unknown', loopRisk: 'false' }
  ])
    assert.deepEqual(parseReplyVerdict(JSON.stringify(verdict)), { reply: false, reason: 'none' });
});
