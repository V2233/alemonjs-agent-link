import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { storedKeyBalance } from '../lib/credentials/key-balance.js';
import { keyringStorageKey, changeKeyring, readKeyring } from '../lib/credentials/keyring.js';
import { bindPersonalKey, getPersonalCredential, isPersonalKeyCommand } from '../lib/credentials/personal.js';
import { getGroupCredential, groupStorageKey, updateGroupKey } from '../lib/credentials/group.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';
import { withBudgetScope, budgetedFetch, setGroupKeyDailyLimit, groupKeyBudgetStatus, budgetStatus, manageBudget } from '../lib/billing/budget.js';
import { handleKeyringCommand } from '../lib/response/keyring/res.js';

// Use a dedicated disposable server, never a configured production database.
test('keyring storage and command integration', { skip: !process.env.AGENT_LINK_TEST_REDIS_SERVER }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'keyring-'));
  const socket = join(dir, 'redis.sock');
  const server = spawn(process.env.AGENT_LINK_TEST_REDIS_SERVER, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore'
  });
  const redis = new Redis({ path: socket, retryStrategy: () => 20 });
  redis.on('error', () => {});
  const previous = { fetch: globalThis.fetch, redis: globalThis.ioRedis, config: globalThis.__config, key: process.env.AGENT_LINK_PERSONAL_KEY_FILE };
  try {
    await Promise.race([redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('temporary Redis startup timeout')), 5000).unref())]);
    globalThis.fetch = async () => Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '12.3456' }] });
    globalThis.ioRedis = redis;
    globalThis.__config = { value: { db: { redis: { path: socket } }, 'alemonjs-agent-link': {} } };
    process.env.AGENT_LINK_PERSONAL_KEY_FILE = join(dir, 'master.key');
    const own = { platform: 'qq-bot', userId: 'alice', channelId: 'private:["qq-bot","alice"]' };
    const group = { ...own, channelId: 'group1' };
    const other = { platform: 'qq-bot', userId: 'bob', channelId: 'private:["qq-bot","bob"]' };
    const secret = 'sk-group-fixture123';
    const credential = scope => withBudgetScope(scope, getGroupCredential);
    const command = async (text, options = {}) => {
      const output = [];
      await handleKeyringCommand(
        { Platform: 'qq-bot', UserId: 'alice', ChannelId: 'group1', IsPrivate: false, IsAdmin: true, MessageText: text, ...options },
        { send: async value => output.push(value.format.value) }
      );
      return JSON.stringify(output);
    };
    await t.test('private credentials and saved group keys are separate; validation rejects non-owner private scope', async () => {
      await bindPersonalKey(own, 'sk-private-fixture123');
      await changeKeyring(own, 'add', secret);
      assert.equal((await withBudgetScope(own, getPersonalCredential)).apiKey, 'sk-private-fixture123');
      assert.equal(await credential(group), null);
      assert.equal(await withBudgetScope(group, getPersonalCredential), null);
      assert.equal((await readKeyring(other)).ring.keys.length, 0);
      await assert.rejects(changeKeyring(group, 'add', secret));
      await assert.rejects(changeKeyring({ ...own, channelId: other.channelId }, 'add', secret));
      await assert.rejects(changeKeyring(own, 'grant', '1'));
    });
    await t.test('balances display exact amounts and currencies; failures never disable keys', async () => {
      const original = globalThis.fetch;
      const record = (await readKeyring(own)).ring.keys[0].value;
      try {
        assert.match(await command('/我的钥匙', { IsPrivate: true }), /12.3456 元/);
        assert.match(await command('/我的钥匙 私聊', { IsPrivate: true }), /12.3456 元/);
        globalThis.fetch = async () =>
          Response.json({
            balance_infos: [
              { currency: 'USD', total_balance: '0.0001' },
              { currency: 'CNY', total_balance: '0.00' }
            ]
          });
        assert.equal(await storedKeyBalance(keyringStorageKey(own), own, record), '0.0001 美元 / 0.00 元');
        globalThis.fetch = async () => Response.json({ balance_infos: [{ currency: 'CNY', total_balance: 'secret-invalid' }] });
        assert.equal(await storedKeyBalance(keyringStorageKey(own), own, record), '暂未取得余额');
        globalThis.fetch = async () => {
          throw new Error('private-provider-secret');
        };
        assert.equal(await storedKeyBalance(keyringStorageKey(own), own, record), '查询失败，请稍后刷新');
        assert.equal((await readKeyring(own)).ring.keys[0].value.enabled, true);
        globalThis.fetch = async (url, options) => {
          assert.equal(url, 'https://platform.deepseek.com/api/v0/users/get_user_summary');
          assert.equal(options.headers['x-dsh-auth-token'], secret);
          assert.equal(options.headers.Authorization, undefined);
          assert.equal(options.redirect, 'error');
          return Response.json({
            code: 0,
            data: { biz_code: 0, biz_data: { normal_wallets: [{ currency: 'CNY', balance: '10.25' }], bonus_wallets: [{ currency: 'CNY', balance: '0.75' }] } }
          });
        };
        assert.equal(await storedKeyBalance(keyringStorageKey(own), own, { ...record, auth: 'account' }), '11.00 元');
      } finally {
        globalThis.fetch = original;
      }
    });
    await t.test('only current group admins can list or grant; old routes do not mutate', async () => {
      for (const text of ['/我的钥匙', '/授权钥匙 1']) {
        assert.match(await command(text, { IsAdmin: false, Role: 'member', IsMaster: true }), /仅本群管理员/);
      }
      assert.equal(await credential(group), null);
      for (const entry of ['/个人密钥', '/apikey', '/群密钥', '/groupapikey']) {
        assert.match(await command(`${entry} 绑定 sk-leaked-fixture123`, { IsPrivate: true }), /旧密钥入口已停用/);
      }
      assert.equal((await withBudgetScope(own, getPersonalCredential)).apiKey, 'sk-private-fixture123');
      assert.match(await command('/授权钥匙 1', { IsPrivate: true }), /目标群/);
      assert.match(await command('/授权钥匙 1', { UserId: 'bob' }), /没有这个/);
      const list = await command('/我的钥匙');
      assert.match(list, /钥匙 1/);
      assert.doesNotMatch(list, /sk-|alice|私聊钥匙/);
      assert.match(await command('/授权钥匙 1'), /本群钥匙已授权/);
    });
    await t.test('group copy is encrypted and isolated by group, platform and private account', async () => {
      assert.equal((await credential(group)).apiKey, secret);
      for (const scope of [own, other, { ...group, channelId: 'other-group' }, { ...group, platform: 'other' }]) assert.equal(await credential(scope), null);
      for (const key of await redis.keys('*')) assert.ok(!(await redis.get(key)).includes(secret));
      const copy = JSON.parse(await redis.get(groupStorageKey(group)));
      assert.equal(copy.userId, undefined);
      assert.equal(copy.keyId, undefined);
    });
    await t.test('records are private and owned; invalid IDs and another owner cannot revoke', async () => {
      assert.match(await command('/授权记录'), /请私聊/);
      assert.match(await command('/授权记录', { IsPrivate: true }), /group1/);
      assert.doesNotMatch(await command('/授权记录', { IsPrivate: true, UserId: 'bob' }), /group1/);
      const grant = (await readKeyring(own)).ring.grants[0];
      await assert.rejects(changeKeyring(other, 'revoke', String(grant.id)));
      await assert.rejects(changeKeyring(group, 'revoke', String(grant.id)));
      for (const id of ['0', '-1', '1e0', '1.0', 'abc']) await assert.rejects(changeKeyring(group, 'grant', id));
      assert.equal((await credential(group)).apiKey, secret);
    });
    await t.test('concurrent grants cannot overwrite and failed attempts leave no phantom record', async () => {
      const target = { ...group, channelId: 'group2' };
      const results = await Promise.allSettled([changeKeyring(target, 'grant', '1'), changeKeyring(target, 'grant', '1')]);
      assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
      assert.equal((await readKeyring(own)).ring.grants.filter(x => x.channelId === 'group2').length, 1);
      await assert.rejects(changeKeyring(group, 'grant', '1'));
      assert.equal((await readKeyring(own)).ring.grants.length, 2);
    });
    await t.test('depleted copies remain revocable without affecting original or other groups', async () => {
      const before = await credential(group);
      await updateGroupKey(group, before.revision);
      const grant = (await readKeyring(own)).ring.grants.find(x => x.channelId === 'group1');
      assert.match(await command(`/授权记录 移除 ${grant.id}`, { IsPrivate: true }), /已移除/);
      assert.equal(await redis.get(groupStorageKey(group)), null);
      assert.equal((await readKeyring(own)).ring.keys.length, 1);
      assert.equal((await credential({ ...group, channelId: 'group2' })).apiKey, secret);
      assert.equal((await withBudgetScope(own, getPersonalCredential)).apiKey, 'sk-private-fixture123');
    });
    await t.test('private command lifecycle never changes group copies', async () => {
      await command('/我的钥匙 私聊 停用', { IsPrivate: true });
      assert.equal(await withBudgetScope(own, getPersonalCredential), null);
      assert.equal((await credential({ ...group, channelId: 'group2' })).apiKey, secret);
      await command('/我的钥匙 私聊 启用', { IsPrivate: true });
      assert.equal((await withBudgetScope(own, getPersonalCredential)).apiKey, 'sk-private-fixture123');
      await command('/我的钥匙 私聊 移除', { IsPrivate: true });
      assert.equal(await withBudgetScope(own, getPersonalCredential), null);
      assert.equal((await readKeyring(own)).ring.keys.length, 1);
      assert.match(await command('/我的钥匙 私聊 移除', { IsPrivate: true }), /暂无私聊钥匙/);
    });
    await t.test('another group administrator can remove current copy without owning a key', async () => {
      const target = { ...group, channelId: 'group3' };
      await changeKeyring(target, 'grant', '1');
      const grant = (await readKeyring(own)).ring.grants.find(item => item.channelId === 'group3');
      const options = { ChannelId: 'group3', UserId: 'bob' };
      const view = await command('/我的钥匙', options);
      assert.match(view, /本群钥匙/);
      assert.match(view, /我的钥匙 移除/);
      assert.doesNotMatch(view, /alice|sk-/);
      assert.match(await command('/我的钥匙 移除', { ...options, IsAdmin: false, Role: 'member', IsMaster: true }), /仅本群管理员/);
      await command('/我的钥匙 移除', { ...options, IsPrivate: true });
      assert.equal((await credential(target)).apiKey, secret);
      await updateGroupKey(target, (await credential(target)).revision);
      assert.match(await command('/我的钥匙 移除', options), /本群钥匙已移除/);
      assert.equal(await redis.get(groupStorageKey(target)), null);
      assert.equal((await credential({ ...group, channelId: 'group2' })).apiKey, secret);
      assert.equal((await readKeyring(own)).ring.keys.length, 1);
      assert.match(await command('/授权记录', { IsPrivate: true }), /授权已失效/);
      assert.match(await command('/我的钥匙 移除', options), /尚未授权/);
      await changeKeyring(target, 'grant', '1');
      await changeKeyring(own, 'revoke', String(grant.id));
      assert.equal((await credential(target)).apiKey, secret, 'old owner record cannot remove a later grant');
      const latest = (await readKeyring(own)).ring.grants.find(item => item.channelId === 'group3');
      await changeKeyring(own, 'revoke', String(latest.id));
    });
    await t.test('group enable, disable and daily limit preserve owner and do not charge robot quota', async () => {
      const target = { ...group, channelId: 'protected' };
      await changeKeyring(target, 'grant', '1');
      const opts = { ChannelId: 'protected', UserId: 'bob' };
      assert.match(await command('/我的钥匙 停用', opts), /已停用/);
      assert.equal(await credential(target), null);
      assert.match(await command('/我的钥匙 启用', opts), /已启用/);
      const config = resolveDSHConfig({ budget: { enabled: true }, runtimeMode: 'chat-only' });
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async url => {
        if (String(url).endsWith('/user/balance')) return Response.json({ is_available: true });
        calls++;
        return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 10 } });
      };
      const request = () =>
        withBudgetScope(target, async () =>
          (
            await budgetedFetch(config, new URL('https://api.deepseek.com/chat/completions'), {
              method: 'POST',
              body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] })
            })
          ).text()
        );
      try {
        assert.match(await command('/我的钥匙 上限 1', { ...opts, IsAdmin: false }), /仅本群管理员/);
        await setGroupKeyDailyLimit(target, '0');
        await assert.rejects(request());
        assert.equal(calls, 0);
        await setGroupKeyDailyLimit(target, '1');
        await request();
        const status = await groupKeyBudgetStatus(config, target);
        assert.ok(status.personalUsed > 0 && status.personalUsed < 0.01);
        assert.equal((await budgetStatus(config, target)).personalUsed, 0);
        await setGroupKeyDailyLimit(target, '0.04');
        let release, entered;
        const started = new Promise(resolve => {
          entered = resolve;
        });
        globalThis.fetch = async url => {
          if (String(url).endsWith('/user/balance')) return Response.json({ is_available: true });
          entered();
          await new Promise(resolve => {
            release = resolve;
          });
          return Response.json({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
        };
        const first = request();
        await started;
        try {
          await assert.rejects(request());
        } finally {
          release();
        }
        await first;
        await setGroupKeyDailyLimit(target, '0');
        assert.equal((await groupKeyBudgetStatus(config, target)).personalUsed, status.personalUsed);
        await assert.rejects(request());
        await setGroupKeyDailyLimit(target, '1');
        globalThis.fetch = async url => (String(url).endsWith('/user/balance') ? Response.json({ is_available: true }) : new Response('{}', { status: 402 }));
        await assert.rejects(request(), /余额不足/);
        await assert.rejects(credential(target), /余额不足/);
        await command('/我的钥匙 启用', opts);
        assert.equal((await credential(target)).apiKey, secret);
      } finally {
        globalThis.fetch = original;
      }
      await command('/我的钥匙 移除', opts);
      const grant = (await readKeyring(own)).ring.grants.find(item => item.channelId === 'protected');
      await changeKeyring(own, 'revoke', String(grant.id));
    });
    await t.test('recharge persists across midnight while daily free quota resets', async () => {
      const config = resolveDSHConfig({ budget: { enabled: true } });
      const scope = { ...group, channelId: 'wallet-test' };
      const originalTime = redis.time.bind(redis);
      let timestamp = Date.parse('2026-10-29T12:00:00+08:00') / 1000;
      redis.time = async () => [String(timestamp), '0'];
      try {
        const actor = { isMaster: true, platform: scope.platform, userId: 'owner', channelId: 'owner', messageId: 'recharge-1' };
        await manageBudget(config, scope, actor, 'add', 2000000);
        assert.equal((await budgetStatus(config, scope)).paidRemaining, 2);
        timestamp += 86400;
        assert.equal((await budgetStatus(config, scope)).paidRemaining, 2);
        await manageBudget(config, scope, actor, 'add', 2000000);
        assert.equal((await budgetStatus(config, scope)).paidRemaining, 2, 'delivery retry across days does not add twice');
        const legacy = { ...scope, channelId: 'legacy-wallet' };
        const hash = createHash('sha256')
          .update(JSON.stringify([legacy.platform, legacy.channelId]))
          .digest('hex');
        const day = new Date((timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10);
        const legacyKey = `data:{agent-link-budget}:v1:${day}:${hash}`;
        await redis.hset(legacyKey, 'paidLimit', '3000000', 'paidUsed', '1000000', 'paidReserved', '1');
        await assert.rejects(budgetStatus(config, legacy), /待结算/);
        await redis.hset(legacyKey, 'paidReserved', '0');
        assert.equal((await budgetStatus(config, legacy)).paidRemaining, 2);
        assert.equal((await budgetStatus(config, legacy)).paidRemaining, 2, 'migration is idempotent');
        for (const wallet of await redis.keys('*:wallet:*')) assert.equal(await redis.ttl(wallet), -1);
      } finally {
        redis.time = originalTime;
      }
    });
    await t.test('stale grant cannot delete a replacement copy', async () => {
      const target = { ...group, channelId: 'group2' };
      const grant = (await readKeyring(own)).ring.grants[0];
      const raw = JSON.parse(await redis.get(groupStorageKey(target)));
      raw.grantToken = 'new-owner-token';
      await redis.set(groupStorageKey(target), JSON.stringify(raw));
      await changeKeyring(own, 'revoke', String(grant.id));
      assert.equal((await credential(target)).apiKey, secret);
      assert.equal((await readKeyring(own)).ring.grants.length, 0);
    });
  } finally {
    globalThis.fetch = previous.fetch;
    globalThis.ioRedis = previous.redis;
    globalThis.__config = previous.config;
    if (previous.key === undefined) delete process.env.AGENT_LINK_PERSONAL_KEY_FILE;
    else process.env.AGENT_LINK_PERSONAL_KEY_FILE = previous.key;
    redis.disconnect();
    const stopped = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await stopped;
    await rm(dir, { recursive: true, force: true });
  }
});

test('new and legacy key commands remain excluded from history', () => {
  for (const command of ['我的钥匙', '授权钥匙', '授权记录', '个人密钥', 'apikey', '群密钥', 'groupapikey'])
    assert.equal(isPersonalKeyCommand(`/${command} secret`), true);
  assert.equal(isPersonalKeyCommand('普通聊天'), false);
});
