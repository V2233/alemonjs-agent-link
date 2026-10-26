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
      assert.equal(body.model, 'deepseek-flash');
      assert.deepEqual(body.thinking, { type: 'disabled' });
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

test('classifier does not send DeepSeek-specific thinking parameters to other compatible providers', async () => {
  const { classifyGroupReply } = await import('../lib/social/reply-gate.js');
  const oldConfig = globalThis.__config,
    oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { apiKey: 'test', baseUrl: 'https://other.test/v1', model: 'test' } } };
  let called = false;
  try {
    globalThis.fetch = async (_url, options) => {
      called = true;
      assert.equal(JSON.parse(options.body).thinking, undefined);
      return Response.json({ choices: [{ message: { content: '{"reply":false,"reason":"none","source":"unknown","loopRisk":false}' } }] });
    };
    await classifyGroupReply({ recent: [], messages: [] }, new AbortController().signal);
    assert.equal(called, true);
  } finally {
    globalThis.__config = oldConfig;
    globalThis.fetch = oldFetch;
  }
});

test('gate model overrides are hot-read, independent, and never leak keys across providers', async () => {
  const { classifyGroupReply } = await import('../lib/social/reply-gate.js');
  const previousConfig = globalThis.__config,
    previousFetch = globalThis.fetch;
  const scenarios = [
    { settings: { apiKey: 'main', model: 'deepseek-v4-pro' }, model: 'deepseek-flash', key: 'main', host: 'api.deepseek.com' },
    { settings: { apiKey: 'main', model: 'expensive', replyGate: { model: 'custom-cheap' } }, model: 'custom-cheap', key: 'main', host: 'api.deepseek.com' },
    { settings: { apiKey: 'main', baseUrl: 'https://other.test/v1', model: 'existing' }, model: 'existing', key: 'main', host: 'other.test' },
    {
      settings: { apiKey: 'main', replyGate: { baseUrl: 'https://other.test/v1', model: 'cheap', apiKey: 'separate' } },
      model: 'cheap',
      key: 'separate',
      host: 'other.test'
    },
    { settings: { replyGate: { apiKey: 'standalone' } }, model: 'deepseek-flash', key: 'standalone', host: 'api.deepseek.com' },
    { settings: { apiKey: 'main', replyGate: { model: '', baseUrl: '', apiKey: '' } }, model: 'deepseek-flash', key: 'main', host: 'api.deepseek.com' },
    { settings: { apiKey: 'main', replyGate: { baseUrl: 'https://other.test/v1', model: 'cheap' } }, skip: true },
    { settings: { apiKey: 'main', replyGate: { baseUrl: 'https://other.test/v1', apiKey: 'separate' } }, skip: true },
    { settings: { replyGate: {} }, skip: true }
  ];
  try {
    for (const scenario of scenarios) {
      globalThis.__config = { value: { 'alemonjs-agent-link': scenario.settings } };
      let called = false;
      globalThis.fetch = async (url, options) => {
        called = true;
        assert.equal(scenario.skip, undefined);
        assert.equal(url.hostname, scenario.host);
        assert.equal(options.headers.Authorization, `Bearer ${scenario.key}`);
        const body = JSON.parse(options.body);
        assert.equal(body.model, scenario.model);
        assert.equal(body.max_tokens, 120);
        assert.equal(body.tools, undefined);
        assert.equal(body.thinking?.type, scenario.host === 'api.deepseek.com' ? 'disabled' : undefined);
        return Response.json({ choices: [{ message: { content: '{"reply":true,"reason":"support","source":"human","loopRisk":false}' } }] });
      };
      const result = await classifyGroupReply({ recent: [], messages: [] }, new AbortController().signal);
      assert.equal(called, !scenario.skip);
      assert.equal(result.reply, !scenario.skip);
    }
  } finally {
    globalThis.__config = previousConfig;
    globalThis.fetch = previousFetch;
  }
});

test('gate configuration rejects malformed fields without echoing credentials', async () => {
  const { resolveDSHConfig } = await import('../lib/dsh/config.js');
  for (const replyGate of [null, [], 'bad', { model: 1 }, { apiKey: true }, { baseUrl: 'http://bad.test' }, { baseUrl: 'https://secret@bad.test' }]) {
    assert.throws(
      () => resolveDSHConfig({ replyGate }),
      error => error.message.includes('replyGate') && !error.message.includes('secret')
    );
  }
});
