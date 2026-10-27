import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import YAML from 'yaml';
import {
  bindPersonalKey,
  claimPersonalKeyCommand,
  checkedPersonalCredential,
  getPersonalCredential,
  personalKeyStatus,
  updatePersonalKey,
  isPersonalKeyCommand
} from '../lib/credentials/personal.js';
import { budgetedFetch, budgetStatus, withBudgetScope } from '../lib/billing/budget.js';
import { getChatCredentials, getDSHCredentials } from '../lib/dsh/credentials.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';

test('personal key commands are recognizable before archive and group storage is rejected', async () => {
  for (const text of ['/个人密钥 绑定 sk-test12345678', '/apikey 停用', ' /APIKEY 状态']) assert.equal(isPersonalKeyCommand(text), true);
  assert.equal(isPersonalKeyCommand('/apikeyextra'), false);
  await assert.rejects(bindPersonalKey({ platform: 'qq', channelId: 'group', userId: 'u' }, 'sk-test12345678'), /本人私聊/);
});

test('key commands never enter application archives, references or edited-message context', async () => {
  const { archiveIncoming } = await import('../lib/history/capture.js');
  const { messageReferences } = await import('../lib/social/references.js');
  const { EventContextStore } = await import('../lib/social/event-context.js');
  const secret = 'sk-fixture-0004';
  const event = { Platform: 'test', UserId: 'u', IsPrivate: true, MessageId: 'secret-msg', MessageText: `/个人密钥 绑定 ${secret}` };
  archiveIncoming({}, event); // returns before accessing history configuration or storage
  assert.deepEqual(await messageReferences.capture(event), { forwarded: '' });
  const contexts = new EventContextStore();
  contexts.record({ ...event, name: 'private.message.update' });
  assert.equal(contexts.context(event).includes(secret), false);
});

test('personal key encryption, isolation, manual switches and depletion fallback', { skip: !process.env.AGENT_LINK_TEST_REDIS_CONFIG }, async t => {
  const redisConfig = YAML.parse(await readFile(process.env.AGENT_LINK_TEST_REDIS_CONFIG, 'utf8')).db.redis;
  const namespace = `personal-key-test:${randomUUID()}:`;
  const redis = new Redis({ ...redisConfig, keyPrefix: namespace, maxRetriesPerRequest: 0, commandTimeout: 5000, retryStrategy: () => null });
  redis.on('error', () => {});
  await redis.ping();
  const dir = await mkdtemp(join(tmpdir(), 'agent-personal-key-'));
  const previous = { redis: globalThis.ioRedis, fetch: globalThis.fetch, config: globalThis.__config, keyFile: process.env.AGENT_LINK_PERSONAL_KEY_FILE };
  globalThis.ioRedis = redis;
  globalThis.__config = { value: { 'alemonjs-agent-link': { aiEnabled: true, apiKey: 'sk-shared-test-key', budget: { enabled: true } } } };
  process.env.AGENT_LINK_PERSONAL_KEY_FILE = join(dir, 'master.key');
  const scope = { platform: 'test', userId: 'u', channelId: 'private:["test","u"]' };
  const other = { platform: 'test', userId: 'other', channelId: 'private:["test","other"]' };
  const config = resolveDSHConfig({ budget: { enabled: true }, runtimeMode: 'chat-only' });
  const secret = 'sk-fixture-0005';
  let mode = 'ok',
    calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), key: new Headers(init.headers).get('Authorization') });
    if (String(url).endsWith('/user/balance')) {
      if (mode === 'timeout') throw new Error('timeout');
      if (mode === 'invalid') return Response.json({}, { status: 401 });
      return Response.json({ is_available: mode !== 'empty' });
    }
    if (mode === '402' && new Headers(init.headers).get('Authorization') === `Bearer ${secret}`) return Response.json({}, { status: 402 });
    return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  };
  const request = (s = scope, personalKey = false) =>
    withBudgetScope(s, async () =>
      (
        await budgetedFetch(config, new URL('https://api.deepseek.com/chat/completions'), {
          method: 'POST',
          personalKey,
          headers: { Authorization: personalKey ? `Bearer ${secret}` : 'Bearer sk-shared-test-key' },
          body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }] })
        })
      ).text()
    );
  try {
    await t.test('bind encrypts at rest, resolves only in owner private scope, never changes global credentials', async () => {
      assert.equal(await claimPersonalKeyCommand(scope, 'binding-message'), true);
      assert.equal(await claimPersonalKeyCommand(scope, 'binding-message'), false);
      await bindPersonalKey(scope, secret);
      assert.equal((await stat(process.env.AGENT_LINK_PERSONAL_KEY_FILE)).mode & 0o777, 0o600);
      const keys = await redis.keys(`${namespace}*`);
      for (const key of keys) assert.equal(String(await redis.get(key.slice(namespace.length))).includes(secret), false);
      assert.equal((await withBudgetScope(scope, () => getChatCredentials())).apiKey, secret);
      assert.equal((await getDSHCredentials()).apiKey, 'sk-shared-test-key');
      assert.equal(await withBudgetScope(other, () => getPersonalCredential()), null);
      assert.equal(await withBudgetScope({ ...scope, channelId: 'group' }, () => getPersonalCredential()), null);
      await assert.rejects(request({ ...scope, channelId: 'group' }, true), /本人私聊/);
    });
    await t.test('personal requests bypass both quota ledgers', async () => {
      await request();
      assert.equal(calls.at(-1).key, `Bearer ${secret}`);
      const status = await budgetStatus(config, scope);
      assert.equal(status.used, 0);
      assert.equal(status.personalUsed, 0);
      await request(other);
      assert.equal(calls.at(-1).key, 'Bearer sk-shared-test-key');
    });
    await t.test('unknown failures keep enabled and do not charge the robot', async () => {
      for (mode of ['timeout', 'invalid']) {
        const before = (await budgetStatus(config, scope)).used;
        await assert.rejects(request(), /查询/);
        assert.equal((await personalKeyStatus(scope)).enabled, true);
        assert.equal((await budgetStatus(config, scope)).used, before);
      }
    });
    await t.test('explicit insufficient balance disables persistently and falls back through budget', async () => {
      mode = 'empty';
      calls = [];
      await request(scope, true);
      assert.equal(calls.at(-1).key, 'Bearer sk-shared-test-key');
      assert.equal((await personalKeyStatus(scope)).reason, 'balance');
      assert.equal((await budgetStatus(config, scope)).used, 0.00036);
      mode = 'ok';
      calls = [];
      await request();
      assert.equal(
        calls.some(call => call.url.endsWith('/user/balance')),
        false
      );
      assert.equal(calls.at(-1).key, 'Bearer sk-shared-test-key');
      await updatePersonalKey(scope, 'enable');
      await request();
      assert.equal(calls.at(-1).key, `Bearer ${secret}`);
    });
    await t.test('workspace receives only this private credential and stops without replay on depletion', async () => {
      const { streamChat } = await import('../lib/dsh/client.js');
      const { setDSHBridgeForTesting } = await import('../lib/dsh/supervisor.js');
      const original = globalThis.fetch;
      let workspaceCalls = 0,
        exhausted = false;
      setDSHBridgeForTesting({ url: 'http://bridge.test', token: 'bridge-test-token' });
      globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/user/balance')) return Response.json({ is_available: true });
        assert.equal(String(url), 'http://bridge.test/v1/chat');
        assert.equal(JSON.parse(options.body).personalApiKey, secret);
        assert.equal(options.headers.Authorization, 'Bearer bridge-test-token');
        workspaceCalls++;
        return new Response(
          exhausted ? 'data: {"type":"personal_key_exhausted"}\n\n' : 'data: {"type":"content","content":"done"}\n\ndata: {"type":"done"}\n\n',
          {
            headers: { 'Content-Type': 'text/event-stream' }
          }
        );
      };
      try {
        const before = (await budgetStatus(config, scope)).used;
        await withBudgetScope(scope, () => streamChat(config, 'dsh:qq:private:test', 'hello', async () => {}, 'u'));
        assert.equal((await budgetStatus(config, scope)).used, before);
        exhausted = true;
        await assert.rejects(
          withBudgetScope(scope, () => streamChat(config, 'dsh:qq:private:test', 'hello', async () => {}, 'u')),
          /自动停用/
        );
        assert.equal(workspaceCalls, 2);
        assert.equal((await personalKeyStatus(scope)).enabled, false);
        await updatePersonalKey(scope, 'enable');
      } finally {
        setDSHBridgeForTesting(null);
        globalThis.fetch = original;
      }
    });
    await t.test('HTTP 402 switches just the rejected model request; manual off/on and stale CAS are safe', async () => {
      mode = '402';
      calls = [];
      await request();
      assert.equal(calls.filter(call => !call.url.endsWith('/user/balance')).length, 2);
      assert.equal(calls.at(-1).key, 'Bearer sk-shared-test-key');
      assert.equal((await personalKeyStatus(scope)).enabled, false);
      await updatePersonalKey(scope, 'enable');
      const old = await withBudgetScope(scope, () => getPersonalCredential());
      await bindPersonalKey(scope, 'sk-fixture-0006');
      assert.equal(await updatePersonalKey(scope, 'disable', old.revision), false);
      assert.equal((await personalKeyStatus(scope)).enabled, true);
      await updatePersonalKey(scope, 'disable');
      assert.equal(await withBudgetScope(scope, () => getPersonalCredential()), null);
      await updatePersonalKey(scope, 'remove');
      assert.equal((await personalKeyStatus(scope)).bound, false);
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
