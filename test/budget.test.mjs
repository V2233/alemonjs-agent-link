import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import YAML from 'yaml';
import {
  budgetNoticeScript,
  claimBudgetNotice,
  claimReplyGateBudgetNotice,
  replyGateExceededMessage,
  reserveWorkspaceText,
  textBudgetInput,
  budgetDay,
  budgetLimit,
  officialRates,
  parseUsage,
  usageCost,
  budgetedFetch,
  budgetStatus,
  replyGateBudgetStatus,
  withBudgetScope,
  reserveScript,
  settleScript,
  manageBudget,
  budgetAdjustments
} from '../lib/billing/budget.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';

test.beforeEach(() => {
  globalThis.__config = { value: { 'alemonjs-agent-link': { aiEnabled: true } } };
});

const url = new URL('https://api.deepseek.com/chat/completions');
const config = resolveDSHConfig({ budget: { enabled: true }, runtimeMode: 'chat-only' });
const init = () => ({ method: 'POST', body: JSON.stringify({ model: 'deepseek-flash', stream: false, messages: [{ role: 'user', content: '你好' }] }) });
const scope = { platform: 'test', channelId: 'group-1', userId: 'u1' };

test('Shanghai day boundaries, group/private limits, price aliases and validation', () => {
  assert.equal(budgetDay(Date.parse('2026-10-26T15:59:59Z')), '2026-10-26');
  assert.equal(budgetDay(Date.parse('2026-10-26T16:00:00Z')), '2026-10-27');
  assert.equal(budgetLimit(config, scope), 1_000_000);
  assert.equal(budgetLimit(config, { ...scope, channelId: 'private:["qq","u"]' }), 1_000_000);
  assert.deepEqual(officialRates(url, 'deepseek-v4-flash'), officialRates(url, 'deepseek-flash'));
  assert.equal(
    usageCost(parseUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 500 }), officialRates(url, 'deepseek-flash')),
    1820
  );
  assert.equal(parseUsage({ prompt_tokens: 10, completion_tokens: -1 }), undefined);
  assert.equal(parseUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 11 }), undefined);
  assert.throws(() => officialRates(new URL('https://relay.invalid/chat/completions'), 'deepseek-flash'), /价格/);
  for (const budget of [
    { enabled: 'true' },
    { groupDailyYuan: -1 },
    { privateDailyYuan: Infinity },
    { replyGateDailyYuan: -1 },
    { replyGateGlobalDailyYuan: -1 },
    { maxOutputTokens: 0 }
  ]) {
    assert.throws(() => resolveDSHConfig({ budget }), /budget/);
  }
});

test('missing identity and unknown pricing fail before any provider request', async () => {
  const old = globalThis.fetch;
  const previousKeyFile = process.env.AGENT_LINK_PERSONAL_KEY_FILE;
  // A key file left by a real deployment would make the bound-key lookup reach
  // Redis before price validation; this test is about the pre-network checks.
  process.env.AGENT_LINK_PERSONAL_KEY_FILE = join(tmpdir(), `agent-link-budget-${randomUUID()}.key`);
  globalThis.fetch = () => assert.fail('must not contact provider');
  try {
    await assert.rejects(budgetedFetch(config, url, init()), /所属会话/);
    await assert.rejects(
      withBudgetScope(scope, () => budgetedFetch(config, new URL('https://relay.invalid/chat/completions'), init())),
      /价格/
    );
  } finally {
    globalThis.fetch = old;
    if (previousKeyFile === undefined) delete process.env.AGENT_LINK_PERSONAL_KEY_FILE;
    else process.env.AGENT_LINK_PERSONAL_KEY_FILE = previousKeyFile;
  }
});

test('image payload size and URLs are excluded from text-only budget projection', () => {
  const message = content => ({ messages: [{ role: 'user', content }] });
  const a = textBudgetInput(
    message([
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,small' } }
    ])
  );
  const b = textBudgetInput(
    message([
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'a'.repeat(1000000) } }
    ])
  );
  assert.deepEqual(a, b);
  assert.equal(a.hasImages, true);
  assert.equal(a.bytes, textBudgetInput(message('看看这张图')).bytes);
});

test('Redis outage blocks payment, never falls back to a local counter', async () => {
  const oldRedis = globalThis.ioRedis,
    oldFetch = globalThis.fetch;
  globalThis.ioRedis = {
    status: 'ready',
    ping: async () => {
      throw new Error('offline');
    }
  };
  globalThis.fetch = () => assert.fail('Redis failure must block provider');
  try {
    await assert.rejects(
      withBudgetScope(scope, () => budgetedFetch(config, url, init())),
      /Redis/
    );
  } finally {
    globalThis.ioRedis = oldRedis;
    globalThis.fetch = oldFetch;
  }
});

// Opt-in: uses ONLY random, prefixed keys; never calls the paid provider.
test('real Redis admission, usage settlement, failure retention, isolation and replay', { skip: !process.env.AGENT_LINK_TEST_REDIS_CONFIG }, async t => {
  const credentials = YAML.parse(await readFile(process.env.AGENT_LINK_TEST_REDIS_CONFIG, 'utf8')).db.redis;
  const namespace = `agent-link-test:${randomUUID()}:`;
  const redis = new Redis({ ...credentials, keyPrefix: namespace, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on('error', () => {});
  await redis.ping();
  const oldRedis = globalThis.ioRedis,
    oldFetch = globalThis.fetch;
  globalThis.ioRedis = redis;
  let fetched = 0;
  globalThis.fetch = async (_url, options) => {
    fetched++;
    assert.equal(JSON.parse(options.body).max_tokens, 2048);
    return Response.json({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 50 } });
  };
  const request = (s = scope, c = config, options = init()) => withBudgetScope(s, async () => (await budgetedFetch(c, url, options)).text());
  try {
    await t.test('settles actual tokens and separates platforms, groups, private users', async () => {
      await request();
      const status = await budgetStatus(config, scope);
      assert.equal(status.used, 0.000262);
      assert.equal(status.reserved, 0);
      assert.equal(status.requests, 1);
      assert.equal(status.promptTokens, 100);
      for (const other of [
        { ...scope, platform: 'other' },
        { ...scope, channelId: 'group-2' },
        { ...scope, channelId: 'private:["test","u"]' }
      ]) {
        assert.equal((await budgetStatus(config, other)).used, 0);
      }
    });
    await t.test('a fresh connection sees the same durable daily balance', async () => {
      const other = new Redis({ ...credentials, keyPrefix: namespace, maxRetriesPerRequest: 0, retryStrategy: () => null });
      other.on('error', () => {});
      await other.ping();
      try {
        globalThis.ioRedis = other;
        assert.equal((await budgetStatus(config, scope)).used, 0.000262);
      } finally {
        globalThis.ioRedis = redis;
        other.disconnect();
      }
    });
    await t.test('concurrent reservations cannot all spend the same balance', async () => {
      const s = { ...scope, channelId: 'parallel' };
      const c = { ...config, budget: { enabled: true, personalDailyYuan: 0.04 } };
      const fetchBefore = fetched;
      const pending = [];
      globalThis.fetch = async () => {
        fetched++;
        return new Promise(resolve => pending.push(resolve));
      };
      const jobs = Array.from({ length: 12 }, () =>
        request(s, c).then(
          () => true,
          () => false
        )
      );
      // Wait for a provider request while the entire admission batch competes.
      for (let i = 0; i < 100 && !pending.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(fetched - fetchBefore, 1);
      for (const resolve of pending) resolve(Response.json({ choices: [] }));
      const results = await Promise.all(jobs);
      assert.equal(results.filter(Boolean).length, 1);
      const status = await budgetStatus(c, s);
      assert.ok(status.used > 0 && status.used <= 0.04);
      assert.equal(status.reserved, status.used);
      await assert.rejects(request(s, c), /额度不足/);
    });
    await t.test('split streaming usage footer settles before DONE is delivered', async () => {
      const s = { ...scope, channelId: 'stream' };
      globalThis.fetch = async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body).stream_options, { include_usage: true });
        const text =
          'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\ndata: [DONE]\n\n';
        const bytes = new TextEncoder().encode(text);
        return new Response(
          new ReadableStream({
            start(c) {
              for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
              c.close();
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        );
      };
      const options = init();
      options.body = JSON.stringify({ ...JSON.parse(options.body), stream: true });
      const text = await request(s, config, options);
      assert.match(text, /你好/);
      assert.equal((await budgetStatus(config, s)).used, 0.00036);
      assert.equal((await budgetStatus(config, s)).reserved, 0);
    });
    await t.test('images reach provider intact but combined image input usage is not charged', async () => {
      const s = { ...scope, channelId: 'images' };
      const body = {
        model: 'deepseek-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看看图片' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abcd' } }
            ]
          }
        ]
      };
      globalThis.fetch = async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body).messages, body.messages);
        return Response.json({
          choices: [{ message: { content: '看到了' } }],
          usage: { prompt_tokens: 100000, completion_tokens: 20, prompt_cache_hit_tokens: 20000 }
        });
      };
      await request(s, config, { ...init(), body: JSON.stringify(body) });
      const status = await budgetStatus(config, s);
      const estimate = Math.ceil(textBudgetInput(body).bytes / 3);
      assert.equal(status.promptTokens, estimate);
      assert.equal(status.cacheHitTokens, 0);
      assert.equal(status.used, (estimate * 2 + 20 * 8) / 1000000);
      assert.equal(status.reserved, 0);
    });
    await t.test('network/HTTP failure and missing usage retain debits', async () => {
      for (const mode of ['network', 'http', 'missing']) {
        const s = { ...scope, channelId: mode };
        globalThis.fetch = async () => {
          if (mode === 'network') throw new Error('offline');
          return Response.json({ choices: [] }, { status: mode === 'http' ? 500 : 200 });
        };
        await request(s).catch(() => undefined);
        const status = await budgetStatus(config, s);
        assert.ok(status.used > 0);
        assert.equal(status.used, status.reserved);
      }
    });
    await t.test('settlement is idempotent and stays on admission day', async () => {
      const keys = ['old-day:scope', 'old-day:all', 'old-day:request', 'old-day:person'];
      assert.equal(await redis.eval(reserveScript, 4, ...keys, 100, 200, 0, 3600, 200), 1);
      assert.equal(await redis.eval(settleScript, 4, ...keys, 40, 10, 2, 0), 1);
      assert.equal(await redis.eval(settleScript, 4, ...keys, 40, 10, 2, 0), 0);
      assert.equal(await redis.hget(keys[0], 'used'), '40');
      assert.equal(await redis.exists('next-day:scope'), 0);
    });
    await t.test('manual grants are atomic, idempotent, audited and used for admission without clearing spend', async () => {
      const s = { ...scope, channelId: 'manual' };
      const actor = { isMaster: true, platform: s.platform, channelId: 'owner-private', userId: 'owner', messageId: randomUUID() };
      const grants = await Promise.all(Array.from({ length: 8 }, () => manageBudget(config, s, actor, 'add', 1000000)));
      assert.ok(grants.every(grant => grant.after === 1000000));
      assert.equal((await budgetStatus(config, s)).limit, 2);
      assert.equal((await budgetAdjustments(s, true)).length, 1);
      await assert.rejects(manageBudget(config, s, actor, 'add', 2000000), /已处理/);
      await assert.rejects(manageBudget(config, s, { ...actor, messageId: '' }, 'add', 1000000), /消息编号/);
      await Promise.all(Array.from({ length: 5 }, () => manageBudget(config, s, { ...actor, messageId: randomUUID() }, 'add', 1000000)));
      assert.equal((await budgetStatus(config, s)).limit, 7);
      globalThis.fetch = async () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [] });
      await request(s);
      const spent = (await budgetStatus(config, s)).used;
      assert.ok(spent > 0);
      await manageBudget(config, s, { ...actor, messageId: randomUUID() }, 'set', 0);
      const frozen = await budgetStatus(config, s);
      assert.equal(frozen.freeLimit, 1);
      assert.equal((await replyGateBudgetStatus(config, s)).limit, 0);
      assert.equal(frozen.paidLimit, 6);
      assert.ok(frozen.paidRemaining > 0);
      assert.equal(frozen.used, spent);
      assert.equal(frozen.defaultLimit, 1);
      await request(s); // recharge remains usable when free allowance is zero
      await manageBudget(config, s, { ...actor, messageId: randomUUID() }, 'add', 1000000);
      await request(s);
      assert.ok((await budgetStatus(config, s)).used > spent);
    });
    await t.test('notice caps are atomic rolling 3/hour, 5/6 hours, 7/day and deduplicate messages', async () => {
      const key = 'notice-windows';
      const invoke = id => redis.eval(budgetNoticeScript, 1, key, id);
      const admitted = await Promise.all(Array.from({ length: 20 }, (_, i) => invoke(`a${i}`)));
      assert.equal(admitted.filter(n => n === 1).length, 3);
      const at = Number((await redis.time())[0]) * 1000;
      let ids = await redis.zrange(key, 0, -1);
      assert.equal(await invoke(ids[0]), 0);
      for (const id of ids) await redis.zadd(key, at - 2 * 3600000, id);
      assert.equal(await invoke('b1'), 1);
      assert.equal(await invoke('b2'), 1);
      assert.equal(await invoke('b3'), 0);
      ids = await redis.zrange(key, 0, -1);
      for (const id of ids) await redis.zadd(key, at - 7 * 3600000, id);
      assert.equal(await invoke('c1'), 1);
      assert.equal(await invoke('c2'), 1);
      assert.equal(await invoke('c3'), 0);
      ids = await redis.zrange(key, 0, -1);
      for (const id of ids) await redis.zadd(key, at - 25 * 3600000, id);
      assert.equal(await invoke('next-day'), 1);
      assert.equal(await redis.zcard(key), 1);
      const one = { ...scope, channelId: 'notice-group' };
      for (let i = 0; i < 3; i++) assert.equal(await claimBudgetNotice(one, String(i)), true);
      assert.equal(await claimBudgetNotice(one, 'fourth'), false);
      assert.equal(await claimBudgetNotice({ ...one, channelId: 'notice-other' }, 'fourth'), true);
    });
    await t.test('recognition sends only one group notice, independently of chat notices and recharge', async () => {
      const { respondToGroupBatch } = await import('../lib/social/respond.js');
      const s = { platform: scope.platform, channelId: 'gate-once-notice' };
      const event = { Platform: s.platform, ChannelId: s.channelId };
      let sent = 0;
      const oldFetchForNotice = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error('notice must not call a model');
      };
      try {
        const transport = {
          message: {
            send: async ({ format }) => {
              assert.ok(format);
              sent++;
            }
          }
        };
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            respondToGroupBatch(event, transport, {
              budgetBlocked: true,
              mode: i % 2 ? 'direct' : 'interject',
              anchor: { id: `notice-${i}` },
              messages: []
            })
          )
        );
        assert.equal(sent, 1);
        assert.equal(results.filter(result => result.delivered).length, 1);
        assert.match(replyGateExceededMessage, /不代表群聊天额度已用完|聊天额度单独计算/);
        assert.equal(await claimReplyGateBudgetNotice(s), false);
        const actor = { isMaster: true, platform: s.platform, channelId: 'owner', userId: 'owner', messageId: randomUUID() };
        await manageBudget(config, s, actor, 'add', 1000000);
        assert.equal(await claimReplyGateBudgetNotice(s), false);
        assert.equal(await claimReplyGateBudgetNotice({ ...s, channelId: 'another-gate-notice' }), true);
        for (let i = 0; i < 3; i++) assert.equal(await claimBudgetNotice(s, `ordinary-${i}`), true);
        assert.equal(await claimBudgetNotice(s, 'ordinary-fourth'), false);
      } finally {
        globalThis.fetch = oldFetchForNotice;
      }
    });
    await t.test('classifier has independent group allowance, stops on its limit and resumes with shared recharge', async () => {
      const { classifyGroupReply } = await import('../lib/social/reply-gate.js');
      const oldConfig = globalThis.__config;
      globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: true }, apiKey: 'test-key' } } };
      const s = { ...scope, channelId: 'free-classifier', userId: 'classifier-user' };
      const actor = { isMaster: true, platform: s.platform, channelId: 'owner', userId: 'owner', messageId: randomUUID() };
      const input = {
        scope: { platform: s.platform, channelId: s.channelId },
        recent: [],
        messages: [{ speaker: 'u', text: '肥鱼你好', called: true, media: [] }]
      };
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return Response.json({
          choices: [{ message: { content: '{"reply":true,"reason":"direct_call","source":"human","loopRisk":false}' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 }
        });
      };
      try {
        assert.equal((await classifyGroupReply(input, new AbortController().signal)).reply, true);
        assert.equal((await budgetStatus(config, s)).used, 0);
        assert.equal((await replyGateBudgetStatus(config, s)).freeUsed, 0.0028);
        const personalBefore = (await budgetStatus(config, s)).personalUsed;
        await manageBudget(config, { ...s, channelId: `private:${JSON.stringify([s.platform, s.userId])}` }, actor, 'set', 1000);
        await assert.rejects(request(s), /额度不足/);
        assert.equal((await budgetStatus(config, s)).blocked, true);
        assert.equal((await classifyGroupReply(input, new AbortController().signal)).reply, true); // chat exhaustion does not block recognition
        globalThis.__config.value['alemonjs-agent-link'].budget.replyGateDailyYuan = 0;
        const before = calls;
        assert.equal((await classifyGroupReply(input, new AbortController().signal)).budgetBlocked, true);
        assert.equal(calls, before);
        await manageBudget(config, s, { ...actor, messageId: randomUUID() }, 'add', 1000000);
        assert.equal((await classifyGroupReply(input, new AbortController().signal)).reply, true);
        assert.equal(calls, before + 1);
        const after = await budgetStatus(config, s);
        assert.equal(after.used, 0.0028);
        assert.equal(after.paidUsed, 0.0028);
        assert.equal(after.freeUsed, personalBefore);
        assert.equal(after.personalUsed, personalBefore);
        assert.equal((await replyGateBudgetStatus(config, s)).paidUsed, 0.0028);
      } finally {
        globalThis.__config = oldConfig;
      }
    });
    await t.test('workspace counts visible text and keeps per-call quota without forcing chat-only', async () => {
      const protectedSandbox = resolveDSHConfig({ budget: { enabled: true }, runtimeMode: 'sandbox' });
      assert.equal(protectedSandbox.runtimeMode, 'sandbox');
      const s = { ...scope, channelId: 'workspace-text' };
      const oldConfig = globalThis.__config;
      globalThis.__config = { value: { 'alemonjs-agent-link': { apiKey: 'test' } } };
      try {
        const finish = await withBudgetScope(s, () => reserveWorkspaceText(protectedSandbox, '你好世界'));
        assert.ok((await budgetStatus(config, s)).reserved > 0);
        await finish('任务完成');
        await finish('任务完成');
        const status = await budgetStatus(config, s);
        assert.equal(status.promptTokens, 4);
        assert.equal(status.completionTokens, 4);
        assert.equal(status.used, 0.00004);
        assert.equal(status.reserved, 0);
        assert.equal(status.requests, 1);
      } finally {
        globalThis.__config = oldConfig;
      }
    });
    await t.test('one person across groups and private chat; group and private recharge are isolated and exempt', async () => {
      const c = { ...config, budget: { ...config.budget, personalDailyYuan: 0.04 } };
      const a = { ...scope, userId: 'shared-user', channelId: 'shared-group-a' };
      const b = { ...a, channelId: 'shared-group-b' };
      const privateScope = { ...a, channelId: 'private:["test","shared-user"]' };
      globalThis.fetch = async () => Response.json({ choices: [] }); // durable reservation
      await request(a, c);
      const first = await budgetStatus(c, a);
      assert.ok(first.personalUsed > 0);
      await assert.rejects(request(b, c), /额度不足/);
      assert.equal((await budgetStatus(c, b)).blocked, true);
      await assert.rejects(request(privateScope, c), /额度不足/);
      const other = { ...b, userId: 'other-user' };
      assert.equal((await budgetStatus(c, other)).blocked, false);
      const actor = { isMaster: true, platform: a.platform, channelId: 'owner', userId: 'owner', messageId: randomUUID() };
      await manageBudget(c, b, actor, 'add', 1000000);
      assert.equal((await budgetStatus(c, b)).blocked, false);
      globalThis.fetch = async () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [] });
      await request(b, c);
      const after = await budgetStatus(c, b);
      assert.equal(after.personalUsed, first.personalUsed);
      assert.equal(after.paidUsed, 0.00036);
      assert.equal(after.freeUsed, first.personalUsed);
      assert.equal(after.globalUsed >= after.used, true);
      assert.equal((await budgetStatus(c, privateScope)).blocked, true);
      await manageBudget(c, privateScope, { ...actor, messageId: randomUUID() }, 'add', 2000000);
      assert.equal((await budgetStatus(c, privateScope)).blocked, false);
      await request(privateScope, c);
      const privateAfter = await budgetStatus(c, privateScope);
      assert.equal(privateAfter.personalUsed, first.personalUsed);
      assert.equal(privateAfter.freeUsed, first.personalUsed);
      assert.equal(privateAfter.paidLimit, 2);
      assert.equal(privateAfter.paidUsed, 0.00036);
      assert.equal((await budgetStatus(c, b)).paidRemaining, after.paidRemaining);
      assert.equal((await budgetStatus(c, a)).paidLimit, 0);
      const otherPrivate = { ...privateScope, userId: 'other-private', channelId: 'private:["test","other-private"]' };
      assert.equal((await budgetStatus(c, otherPrivate)).paidLimit, 0);
      await request(b, c);
      assert.equal((await budgetStatus(c, privateScope)).paidRemaining, privateAfter.paidRemaining);

      await assert.rejects(request({ platform: 'test', channelId: 'no-user' }, c), /所属用户/);
    });
    await t.test('split reservation, refunds, concurrency and next-day isolation', async () => {
      const group = 'split:group',
        all = 'split:all',
        person = 'split:person';
      await redis.hset(group, 'paidLimit', 60);
      const keys = [group, all, 'split:req', person];
      assert.equal(await redis.eval(reserveScript, 4, ...keys, 100, 200, 0, 3600, 50), 1);
      assert.equal(await redis.hget(person, 'used'), '40');
      assert.equal(await redis.hget(group, 'paidUsed'), '60');
      assert.equal(await redis.eval(settleScript, 4, ...keys, 80, 10, 2, 0), 1);
      assert.equal(await redis.eval(settleScript, 4, ...keys, 80, 10, 2, 0), 0);
      assert.equal(await redis.hget(person, 'used'), '20');
      assert.equal(await redis.hget(person, 'reserved'), '0');
      assert.equal(await redis.hget(group, 'paidReserved'), '0');
      const attempts = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          redis.eval(reserveScript, 4, `concurrent:g${i}`, 'concurrent:all', `concurrent:r${i}`, 'concurrent:person', 30, 200, 0, 3600, 100)
        )
      );
      assert.equal(attempts.filter(n => n === 1).length, 3);
      assert.equal(await redis.hget('concurrent:person', 'used'), '90');
      assert.equal(await redis.eval(reserveScript, 4, 'tomorrow:group', 'tomorrow:all', 'tomorrow:req', 'tomorrow:person', 30, 200, 0, 3600, 100), 1);
      assert.equal(await redis.hget('tomorrow:group', 'paidUsed'), '0');
      const refundKeys = ['refund:g', 'refund:all', 'refund:r', 'refund:p'];
      await redis.hset(refundKeys[0], 'paidLimit', 60);
      await redis.eval(reserveScript, 4, ...refundKeys, 100, 200, 0, 3600, 100);
      await redis.eval(settleScript, 4, ...refundKeys, 20, 10, 0, 0);
      assert.equal(await redis.hget(refundKeys[0], 'paidUsed'), '20');
      assert.equal(await redis.hget(refundKeys[3], 'used'), '0');
      assert.equal(await redis.hget(refundKeys[1], 'used'), '20');
      await redis.hset(refundKeys[3], 'used', 1000);
      await redis.hset(refundKeys[0], 'limitOverride', 0);
      assert.equal(await redis.eval(reserveScript, 4, refundKeys[0], refundKeys[1], 'paid-only:r', refundKeys[3], 30, 200, 0, 3600, 100), 1);
      assert.equal(await redis.hget(refundKeys[3], 'used'), '1000');
    });
    await t.test('recognition and chat share recharge atomically but keep free ledgers separate', async () => {
      const group = 'gate:g',
        all = 'gate:all',
        gate = 'gate:ledger';
      await redis.hset(group, 'paidLimit', 100);
      const results = await Promise.all([
        redis.eval(reserveScript, 4, group, all, 'gate:r1', gate, 70, 0, 0, 3600, 0, 'reply-gate'),
        redis.eval(reserveScript, 4, group, all, 'gate:r2', 'gate:person', 70, 0, 0, 3600, 0, 'chat')
      ]);
      assert.equal(results.filter(n => n === 1).length, 1);
      assert.equal(await redis.hget(group, 'paidUsed'), '70');
      const winner = results[0] === 1 ? ['gate:r1', gate] : ['gate:r2', 'gate:person'];
      await redis.eval(settleScript, 4, group, all, ...winner, 20, 10, 0, 0);
      assert.equal(await redis.hget(group, 'paidUsed'), '20');
      assert.equal(await redis.hget(all, 'used'), '20');
      assert.equal(await redis.eval(reserveScript, 4, 'free:g', 'free:all', 'free:r', 'free:gate', 100, 100, 0, 3600, 0, 'reply-gate'), 1);
      await redis.eval(settleScript, 4, 'free:g', 'free:all', 'free:r', 'free:gate', 40, 10, 0, 0);
      assert.equal(await redis.hget('free:g', 'used'), '0');
      assert.equal(await redis.hget('free:gate', 'used'), '40');
      assert.equal(await redis.hget('free:all', 'used'), '40');
      assert.equal(await redis.eval(reserveScript, 4, 'free:g', 'free:all', 'free:r2', 'free:gate', 100, 100, 0, 3600, 0, 'reply-gate'), 0);
      assert.equal(await redis.eval(reserveScript, 4, 'other:g', 'other:all', 'other:r', 'other:gate', 100, 100, 0, 3600, 0, 'reply-gate'), 1);
    });
    await t.test('global cap is atomic across different groups', async () => {
      const keys = ['global:scope1', 'global:all', 'global:req1', 'global:person'];
      assert.equal(await redis.eval(reserveScript, 4, ...keys, 90, 200, 100, 3600, 200), 1);
      assert.equal(await redis.eval(reserveScript, 4, 'global:scope2', 'global:all', 'global:req2', 'global:person2', 90, 200, 100, 3600, 200), 0);
    });
    await t.test('group chat has no shared free ceiling and personal overrides apply across group and private', async () => {
      const c = { ...config, budget: { enabled: true, groupDailyYuan: 0, privateDailyYuan: 0, personalDailyYuan: 1 } };
      const a = { ...scope, channelId: 'no-shared-chat-limit', userId: 'fresh-a' };
      const b = { ...a, userId: 'fresh-b' };
      globalThis.fetch = async () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 20 } });
      await request(a, c);
      await request(b, c);
      assert.equal((await budgetStatus(c, a)).personalUsed, 0.00036);
      assert.equal((await budgetStatus(c, b)).personalUsed, 0.00036);
      const actor = { isMaster: true, platform: a.platform, channelId: 'owner', userId: 'owner', messageId: randomUUID() };
      await manageBudget(c, { ...a, channelId: `private:${JSON.stringify([a.platform, a.userId])}` }, actor, 'set', 0);
      await assert.rejects(request(a, c), /额度不足/);
      await request(b, c);
      assert.equal((await budgetStatus(c, b)).personalUsed, 0.00072);
      assert.equal((await replyGateBudgetStatus(c, a)).limit, 1);
    });
    await t.test('recognition global cap blocks only recognition and settles exactly once', async () => {
      const keys = ['gate-global:g', 'gate-global:all', 'gate-global:r', 'gate-global:ledger', 'gate-global:shared'];
      assert.equal(await redis.eval(reserveScript, 5, ...keys, 70, 200, 0, 3600, 0, 'reply-gate', 100), 1);
      assert.equal(
        await redis.eval(reserveScript, 5, 'gate-global:g2', keys[1], 'gate-global:r2', 'gate-global:l2', keys[4], 70, 200, 0, 3600, 0, 'reply-gate', 100),
        0
      );
      assert.equal(await redis.eval(settleScript, 5, ...keys, 20, 10, 0, 0), 1);
      assert.equal(await redis.eval(settleScript, 5, ...keys, 20, 10, 0, 0), 0);
      assert.equal(await redis.hget(keys[4], 'used'), '20');
      assert.equal(
        await redis.eval(reserveScript, 5, 'gate-global:chat', keys[1], 'gate-global:chat-r', 'gate-global:person', keys[4], 100, 0, 0, 3600, 200, 'chat', 100),
        1
      );
    });
    await t.test('unsolicited autonomous messages use only recharge and never debit a member free allowance', async () => {
      const s = { ...scope, channelId: 'autonomous-paid-only', userId: 'not-a-requester', autonomous: true };
      await assert.rejects(request(s), /额度不足/);
      assert.equal((await budgetStatus(config, s)).personalUsed, 0);
      const actor = { isMaster: true, platform: s.platform, channelId: 'owner', userId: 'owner', messageId: randomUUID() };
      await manageBudget(config, s, actor, 'add', 1000000);
      globalThis.fetch = async () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 20 } });
      await request(s);
      const after = await budgetStatus(config, s);
      assert.equal(after.paidUsed, 0.00036);
      assert.equal(after.personalUsed, 0);
    });
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.ioRedis = oldRedis;
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, 'MATCH', `${namespace}*`, 'COUNT', 100);
      cursor = result[0];
      if (result[1].length) await redis.del(...result[1].map(key => key.slice(namespace.length)));
    } while (cursor !== '0');
    redis.disconnect();
  }
});
