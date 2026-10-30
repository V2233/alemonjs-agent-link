import { ResultCode } from 'alemonjs';
import { verifyGroupKeyAdmin } from '../lib/credentials/group-admin.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import YAML from 'yaml';
import { issueGroupKeyCode, redeemGroupKeyCode, groupKeyStatus, getGroupCredential, updateGroupKey } from '../lib/credentials/group.js';
import { getPersonalCredential, isPersonalKeyCommand } from '../lib/credentials/personal.js';
import { getBoundCredential } from '../lib/credentials/scoped.js';
import { getChatCredentials, getDSHCredentials } from '../lib/dsh/credentials.js';
import { budgetedFetch, budgetStatus, manageBudget, withBudgetScope } from '../lib/billing/budget.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';

const requestor = { platform: 'test', channelId: 'g1', userId: 'admin', isPrivate: false, isAdmin: true, messageId: 'issue-message' };
const privateScope = { platform: 'test', userId: 'admin', channelId: 'private:["test","admin"]' };
test('only group administrators can request codes; private attempts and ordinary members are rejected', async () => {
  for (const actor of [
    { ...requestor, isAdmin: false },
    { ...requestor, isPrivate: true },
    { ...requestor, userId: '' },
    { ...requestor, messageId: '' }
  ]) {
    await assert.rejects(issueGroupKeyCode(actor, 'bind'));
  }
  for (const text of ['/群密钥 绑定', '/群密钥 绑定 abc sk-test12345678', '/groupapikey 启用']) assert.equal(isPersonalKeyCommand(text), true);
});

test('administrator verification accepts trusted flags or matching platform roles, never robot-owner status alone', async () => {
  const event = { Platform: 'qq-bot', ChannelId: 'g1', UserId: 'admin', IsPrivate: false };
  const result =
    (data, code = ResultCode.Ok) =>
    async () => ({ code, data });
  assert.equal(await verifyGroupKeyAdmin({ ...event, IsAdmin: true }), true);
  assert.equal(await verifyGroupKeyAdmin(event, result({ UserId: 'admin', GuildId: 'g1', Role: 'admin' })), true);
  assert.equal(await verifyGroupKeyAdmin(event, result({ UserId: 'admin', GuildId: 'g1', Role: 'owner' })), true);
  for (const data of [
    { UserId: 'intruder', GuildId: 'g1', Role: 'admin' },
    { UserId: 'admin', GuildId: 'g2', Role: 'admin' },
    { UserId: 'admin', GuildId: 'g1', Role: 'member' },
    { UserId: 'admin', GuildId: 'g1' }
  ])
    assert.equal(await verifyGroupKeyAdmin({ ...event, IsMaster: true }, result(data)), false);
  assert.equal(await verifyGroupKeyAdmin({ ...event, IsPrivate: true, IsAdmin: true }), false);
  assert.equal(
    await verifyGroupKeyAdmin(event, async () => {
      throw new Error('unavailable');
    }),
    false
  );
});

test('group key grants, encrypted storage, scope isolation and quota fallback', { skip: !process.env.AGENT_LINK_TEST_REDIS_CONFIG }, async t => {
  const connection = YAML.parse(await readFile(process.env.AGENT_LINK_TEST_REDIS_CONFIG, 'utf8')).db.redis;
  const namespace = `group-key-test:${randomUUID()}:`;
  const redis = new Redis({ ...connection, keyPrefix: namespace, maxRetriesPerRequest: 0, commandTimeout: 5000, retryStrategy: () => null });
  redis.on('error', () => {});
  await redis.ping();
  const dir = await mkdtemp(join(tmpdir(), 'agent-group-key-'));
  const previous = { redis: globalThis.ioRedis, fetch: globalThis.fetch, config: globalThis.__config, keyFile: process.env.AGENT_LINK_PERSONAL_KEY_FILE };
  globalThis.ioRedis = redis;
  globalThis.__config = {
    value: { db: { redis: connection }, 'alemonjs-agent-link': { aiEnabled: true, apiKey: 'sk-shared-key-12345678', budget: { enabled: true } } }
  };
  process.env.AGENT_LINK_PERSONAL_KEY_FILE = join(dir, 'master.key');
  const config = resolveDSHConfig({ budget: { enabled: true }, runtimeMode: 'chat-only' });
  const scope = { platform: 'test', channelId: 'g1', userId: 'member' };
  const secret = 'sk-fixture-0002';
  const issue = action => issueGroupKeyCode({ ...requestor, messageId: randomUUID() }, action);
  let mode = 'ok',
    calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), key: new Headers(init.headers).get('Authorization') });
    if (String(url).endsWith('/user/balance')) {
      if (mode === 'network') throw new Error('fixture');
      return Response.json({ is_available: mode !== 'empty' });
    }
    if (mode === '402' && new Headers(init.headers).get('Authorization') === `Bearer ${secret}`) return Response.json({}, { status: 402 });
    return Response.json({
      choices: [{ message: { content: '{"addressed":"name","related":"none","source":"human","loopRisk":false}' } }],
      ...(mode === 'missing-usage' ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20 } })
    });
  };
  const request = (s = scope) =>
    withBudgetScope(s, async () =>
      (
        await budgetedFetch(config, new URL('https://api.deepseek.com/chat/completions'), {
          method: 'POST',
          headers: { Authorization: 'Bearer sk-shared-key-12345678' },
          body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }] })
        })
      ).text()
    );
  try {
    await t.test('proof binds actor, platform, action and group; only one concurrent submission mutates', async () => {
      const proof = await issueGroupKeyCode(requestor, 'bind');
      assert.equal((await issueGroupKeyCode(requestor, 'bind')).code, proof.code);
      await assert.rejects(issueGroupKeyCode(requestor, 'disable'));
      await assert.rejects(redeemGroupKeyCode({ ...privateScope, userId: 'intruder', channelId: 'private:["test","intruder"]' }, proof.code, 'bind', secret));
      await assert.rejects(redeemGroupKeyCode({ ...privateScope, platform: 'other', channelId: 'private:["other","admin"]' }, proof.code, 'bind', secret));
      await assert.rejects(redeemGroupKeyCode(privateScope, proof.code, 'disable'));
      await assert.rejects(redeemGroupKeyCode(scope, proof.code, 'bind', secret));
      const results = await Promise.all(Array.from({ length: 10 }, () => redeemGroupKeyCode(privateScope, proof.code, 'bind', secret)));
      assert.equal(results.filter(result => !result.duplicate).length, 1);
      assert.equal((await groupKeyStatus(scope)).enabled, true);
      const original = await withBudgetScope(scope, getGroupCredential);
      assert.equal(original.apiKey, secret);
      assert.equal((await redeemGroupKeyCode(privateScope, proof.code, 'bind', 'sk-fixture-0003')).duplicate, true);
      assert.equal((await withBudgetScope(scope, getGroupCredential)).revision, original.revision);
      for (const key of await redis.keys(`${namespace}*`)) assert.equal(String(await redis.get(key.slice(namespace.length))).includes(secret), false);
    });
    await t.test('new code invalidates old code; code expiry and action-specific enable/disable are enforced', async () => {
      const old = await issue('bind');
      const stop = await issue('disable');
      await assert.rejects(redeemGroupKeyCode(privateScope, old.code, 'bind', secret));
      await redeemGroupKeyCode(privateScope, stop.code, 'disable');
      assert.equal((await groupKeyStatus(scope)).enabled, false);
      const expired = await issue('enable');
      const proofs = await redis.keys(`${namespace}data:{agent-link-group-keys}:v1:proof:*`);
      assert.equal(proofs.length, 1);
      assert.ok((await redis.ttl(proofs[0].slice(namespace.length))) <= 300);
      await redis.pexpire(proofs[0].slice(namespace.length), 1);
      await new Promise(resolve => setTimeout(resolve, 15));
      await assert.rejects(redeemGroupKeyCode(privateScope, expired.code, 'enable'));
      const enable = await issue('enable');
      await redeemGroupKeyCode(privateScope, enable.code, 'enable');
      assert.equal((await groupKeyStatus(scope)).enabled, true);
    });
    await t.test('group credential never enters another group or any private session; shared supervisor credential stays global', async () => {
      assert.equal((await withBudgetScope(scope, getChatCredentials)).apiKey, secret);
      assert.equal((await getDSHCredentials()).apiKey, 'sk-shared-key-12345678');
      assert.equal(await withBudgetScope({ ...scope, channelId: 'g2' }, getBoundCredential), null);
      assert.equal(await withBudgetScope({ ...scope, platform: 'other' }, getBoundCredential), null);
      assert.equal(await withBudgetScope(privateScope, getBoundCredential), null);
      assert.equal(await withBudgetScope(privateScope, getPersonalCredential), null);
      await request();
      assert.equal(calls.at(-1).key, `Bearer ${secret}`);
      assert.equal((await budgetStatus(config, scope)).used, 0);
      assert.equal((await budgetStatus(config, scope)).personalUsed, 0);
    });
    await t.test('recognition uses group key even when free recognition allowance is zero', async () => {
      const { classifyGroupReply } = await import('../lib/social/reply-gate.js');
      globalThis.__config.value['alemonjs-agent-link'].budget.replyGateDailyYuan = 0;
      const input = {
        scope: { platform: scope.platform, channelId: scope.channelId },
        recent: [],
        messages: [{ speaker: 'u', text: 'hello', called: true, media: [] }]
      };
      assert.equal((await classifyGroupReply(input, new AbortController().signal)).reply, true);
      assert.equal(calls.at(-1).key, `Bearer ${secret}`);
      assert.equal((await budgetStatus(config, scope)).used, 0);
      mode = 'empty';
      assert.equal((await classifyGroupReply(input, new AbortController().signal)).reply, false);
      assert.equal((await groupKeyStatus(scope)).enabled, false);
      mode = 'ok';
      const proof = await issue('enable');
      await redeemGroupKeyCode(privateScope, proof.code, 'enable');
    });
    await t.test('network errors preserve enabled state; model 402 disables only this group and falls back to quota', async () => {
      mode = 'network';
      await assert.rejects(request(), /查询/);
      assert.equal((await groupKeyStatus(scope)).enabled, true);
      mode = '402';
      calls = [];
      await request();
      assert.equal(calls.filter(call => !call.url.endsWith('/user/balance')).length, 2);
      assert.equal(calls.at(-1).key, 'Bearer sk-shared-key-12345678');
      const status = await budgetStatus(config, scope);
      assert.ok(status.used > 0);
      assert.ok(status.personalUsed > 0);
      assert.equal((await groupKeyStatus(scope)).reason, 'balance');
      mode = 'ok';
      calls = [];
      await request();
      assert.equal(
        calls.some(call => call.url.endsWith('/user/balance')),
        false
      );
      const enable = await issue('enable');
      await redeemGroupKeyCode(privateScope, enable.code, 'enable');
      const credential = await withBudgetScope(scope, getGroupCredential);
      const bind = await issue('bind');
      await redeemGroupKeyCode(privateScope, bind.code, 'bind', secret);
      assert.equal(await updateGroupKey(scope, credential.revision), false);
      assert.equal((await groupKeyStatus(scope)).enabled, true);
    });
    await t.test('payment priority is group key, group recharge, then the initiating person free allowance', async () => {
      mode = 'ok';
      const before = await budgetStatus(config, scope);
      const actor = { isMaster: true, platform: scope.platform, channelId: 'owner-private', userId: 'owner', messageId: randomUUID() };
      await manageBudget(config, scope, actor, 'add', 20000);
      await request();
      assert.equal((await budgetStatus(config, scope)).paidUsed, 0);
      assert.equal((await budgetStatus(config, scope)).personalUsed, before.personalUsed);
      mode = 'empty';
      await request();
      const stop = await issue('disable');
      await redeemGroupKeyCode(privateScope, stop.code, 'disable');
      await request();
      assert.equal((await budgetStatus(config, scope)).paidUsed, 0.00072);
      assert.equal((await budgetStatus(config, scope)).personalUsed, before.personalUsed);
      mode = 'missing-usage'; // retain a reservation larger than the remaining recharge
      await request();
      const exhausted = await budgetStatus(config, scope);
      assert.equal(exhausted.paidRemaining, 0);
      assert.ok(exhausted.personalUsed > before.personalUsed);
      mode = 'ok';
      await request();
      const free = await budgetStatus(config, scope);
      assert.ok(Math.abs(free.personalUsed - exhausted.personalUsed - 0.00036) < 1e-9);
      assert.equal(free.paidUsed, exhausted.paidUsed);
      const enable = await issue('enable');
      await redeemGroupKeyCode(privateScope, enable.code, 'enable');
    });
    await t.test('workspace uses this group key and reports depletion without repeating tools', async () => {
      const { streamChat } = await import('../lib/dsh/client.js');
      const { setDSHBridgeForTesting } = await import('../lib/dsh/supervisor.js');
      const original = globalThis.fetch;
      let count = 0;
      setDSHBridgeForTesting({ url: 'http://bridge.test', token: 'fixture-token' });
      globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/user/balance')) return Response.json({ is_available: true });
        assert.equal(String(url), 'http://bridge.test/v1/chat');
        const body = JSON.parse(options.body);
        assert.equal(body.scopedApiKey, secret);
        assert.equal(body.personalApiKey, undefined);
        count++;
        return new Response('data: {"type":"scoped_key_exhausted"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      };
      try {
        await assert.rejects(
          withBudgetScope(scope, () => streamChat(config, 'dsh:qq:group:g1', 'hello', async () => {})),
          /暂停/
        );
        assert.equal(count, 1);
        assert.equal((await groupKeyStatus(scope)).enabled, false);
      } finally {
        setDSHBridgeForTesting(null);
        globalThis.fetch = original;
      }
      const remove = await issue('remove');
      await redeemGroupKeyCode(privateScope, remove.code, 'remove');
      assert.equal((await groupKeyStatus(scope)).bound, false);
    });
  } finally {
    globalThis.ioRedis = previous.redis;
    globalThis.fetch = previous.fetch;
    globalThis.__config = previous.config;
    if (previous.keyFile === undefined) delete process.env.AGENT_LINK_PERSONAL_KEY_FILE;
    else process.env.AGENT_LINK_PERSONAL_KEY_FILE = previous.keyFile;
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, 'MATCH', `${namespace}*`, 'COUNT', 100);
      cursor = result[0];
      if (result[1].length) await redis.del(...result[1].map(key => key.slice(namespace.length)));
    } while (cursor !== '0');
    redis.disconnect();
    await rm(dir, { recursive: true, force: true });
  }
});
