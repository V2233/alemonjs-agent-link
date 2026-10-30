import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyVerdict } from '../lib/social/reply-gate.js';

const rejected = { reply: false, addressed: 'none', related: 'none', reason: 'none' };

test('addressed or related admits a reply; neither is silence', () => {
  assert.deepEqual(parseReplyVerdict('{"addressed":"follow_up","related":"none","source":"unknown","loopRisk":false}'), {
    reply: true,
    addressed: 'follow_up',
    related: 'none',
    reason: 'follow_up',
    source: 'unknown',
    loopRisk: false
  });
  assert.deepEqual(parseReplyVerdict('{"addressed":"none","related":"my_last_reply","source":"human","loopRisk":false}'), {
    reply: true,
    addressed: 'none',
    related: 'my_last_reply',
    reason: 'context',
    source: 'human',
    loopRisk: false
  });
  assert.deepEqual(parseReplyVerdict('{"addressed":"none","related":"none","source":"unknown","loopRisk":false}'), {
    reply: false,
    addressed: 'none',
    related: 'none',
    reason: 'none',
    source: 'unknown',
    loopRisk: false
  });
});

test('strict schema rejects missing, extra, or unknown fields', () => {
  for (const input of [
    'true',
    '```json\n{"addressed":"direct","related":"none","source":"unknown","loopRisk":false}\n```',
    '{"addressed":"direct","related":"none"}',
    '{"addressed":"anything","related":"none","source":"unknown","loopRisk":false}',
    '{"addressed":"none","related":"anything","source":"unknown","loopRisk":false}',
    '{"addressed":"direct","related":"none","source":"robot","loopRisk":false}',
    '{"addressed":"direct","related":"none","source":"unknown","loopRisk":"false"}',
    '{"addressed":"direct","related":"none","source":"unknown","loopRisk":false,"reply":true}',
    'null'
  ]) {
    assert.deepEqual(parseReplyVerdict(input), rejected);
  }
});

test('one-shot classifier uses main credentials, bounded context, no tools, and fails closed', async () => {
  const { classifyGroupReply } = await import('../lib/social/reply-gate.js');
  const config = globalThis.__config,
    oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { apiKey: 'test-gate-key', model: 'test-gate-model' } } };
  const input = {
    recent: Array.from({ length: 6 }, (_, index) => ({ speaker: 'bot', text: `最近${index}` })),
    activity: 'active',
    messages: [{ speaker: 'u1', text: '杭州'.repeat(1000), called: false, media: ['image'] }]
  };
  try {
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'deepseek-flash');
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.equal(body.tools, undefined);
      assert.equal(body.messages.length, 2);
      const compact = JSON.parse(body.messages[1].content);
      assert.equal(compact.recent.length, 6);
      assert.equal(compact.activity, 'active');
      assert.equal(compact.messages[0].text.length, 600);
      assert.match(body.messages[0].content, /addressed/);
      assert.match(body.messages[0].content, /related/);
      assert.doesNotMatch(body.messages[0].content, /open_help|useful_contribution/);
      assert.equal(options.headers.Authorization, 'Bearer test-gate-key');
      return Response.json({
        choices: [{ message: { content: '{"addressed":"none","related":"my_last_reply","source":"unknown","loopRisk":false}' } }]
      });
    };
    assert.deepEqual(await classifyGroupReply(input, new AbortController().signal), {
      reply: true,
      addressed: 'none',
      related: 'my_last_reply',
      reason: 'context',
      source: 'unknown',
      loopRisk: false
    });
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    assert.deepEqual(await classifyGroupReply(input, new AbortController().signal), rejected);
    const abort = new AbortController();
    abort.abort();
    globalThis.fetch = async () => assert.fail('aborted classifier must not send');
    assert.deepEqual(await classifyGroupReply(input, abort.signal), rejected);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__config = config;
  }
});

test('automation and loop assessments veto replies; unknown source is not a bot label', () => {
  for (const verdict of [
    { addressed: 'direct', related: 'none', source: 'automated', loopRisk: false },
    { addressed: 'name', related: 'none', source: 'human', loopRisk: true },
    { addressed: 'none', related: 'my_last_reply', source: 'unknown' },
    { addressed: 'follow_up', related: 'none', source: 'unknown', loopRisk: 'false' }
  ])
    assert.deepEqual(parseReplyVerdict(JSON.stringify(verdict)), rejected);
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
      return Response.json({
        choices: [{ message: { content: '{"addressed":"none","related":"none","source":"unknown","loopRisk":false}' } }]
      });
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
        assert.equal(body.max_tokens, 80);
        assert.equal(body.tools, undefined);
        assert.equal(body.thinking?.type, scenario.host === 'api.deepseek.com' ? 'disabled' : undefined);
        return Response.json({
          choices: [{ message: { content: '{"addressed":"name","related":"none","source":"human","loopRisk":false}' } }]
        });
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

test('pooled reply gate records dedicated outcome statistics and releases reservations', async () => {
  const { classifyGroupReply } = await import('../lib/social/reply-gate.js');
  const { getCredentialPool, stopCredentialPool } = await import('../lib/credentials/pool.js');
  const { getDSHConfig } = await import('../lib/dsh/runtime-config.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'reply-gate-stats-'));
  const previous = globalThis.__config;
  const previousFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        dshHomeRoot: join(root, 'homes'),
        workspaceRoot: join(root, 'work'),
        modelPool: {
          probeIntervalSeconds: 0,
          endpoints: [
            { id: 'gate-stats', provider: 'test', baseUrl: 'https://gate.example', apiKey: 'gate-test-private-key', model: 'gate', capabilities: ['replyGate'] }
          ]
        }
      }
    }
  };
  let failure = false;
  globalThis.fetch = async () =>
    failure
      ? Response.json({ error: { message: 'invalid request' } }, { status: 400 })
      : Response.json({ choices: [{ message: { content: JSON.stringify({ addressed: 'none', related: 'none', source: 'human', loopRisk: false }) } }] });
  try {
    await classifyGroupReply({ recent: [], messages: [] }, new AbortController().signal);
    let row = getCredentialPool(getDSHConfig()).status[0];
    assert.deepEqual(row.purposeStatistics.replyGate, { total: 1, success: 1, failed: 0 });
    assert.equal(row.active, 0);
    failure = true;
    await classifyGroupReply({ recent: [], messages: [] }, new AbortController().signal);
    row = getCredentialPool(getDSHConfig()).status[0];
    assert.deepEqual(row.purposeStatistics.replyGate, { total: 2, success: 1, failed: 1 });
    assert.equal(row.active, 0);
    assert.equal(row.purposeStatistics.chat, undefined);
  } finally {
    stopCredentialPool();
    globalThis.__config = previous;
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('public topic participation is confined to active human conversations', () => {
  const verdict = { addressed: 'none', related: 'open_topic', source: 'human', loopRisk: false };
  assert.equal(parseReplyVerdict(JSON.stringify(verdict), 'active').reply, true);
  for (const activity of [undefined, 'quiet', 'balanced']) {
    assert.deepEqual(parseReplyVerdict(JSON.stringify(verdict), activity), rejected);
  }
  for (const overrides of [{ source: 'automated' }, { source: 'unknown' }, { loopRisk: true }]) {
    assert.deepEqual(parseReplyVerdict(JSON.stringify({ ...verdict, ...overrides }), 'active'), rejected);
  }
});
