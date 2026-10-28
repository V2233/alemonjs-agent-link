import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { changeKeyring, readKeyring } from '../lib/credentials/keyring.js';
import { bindPersonalKey, getPersonalCredential, isPersonalKeyCommand } from '../lib/credentials/personal.js';
import { getGroupCredential, groupStorageKey, updateGroupKey } from '../lib/credentials/group.js';
import { withBudgetScope } from '../lib/billing/budget.js';
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
  const previous = { redis: globalThis.ioRedis, config: globalThis.__config, key: process.env.AGENT_LINK_PERSONAL_KEY_FILE };
  try {
    await Promise.race([redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('temporary Redis startup timeout')), 5000).unref())]);
    globalThis.ioRedis = redis;
    globalThis.__config = { value: { db: { redis: { path: socket } }, 'alemonjs-agent-link': {} } };
    process.env.AGENT_LINK_PERSONAL_KEY_FILE = join(dir, 'master.key');
    const own = { platform: 'test', userId: 'alice', channelId: 'private:["test","alice"]' };
    const group = { ...own, channelId: 'group1' };
    const other = { platform: 'test', userId: 'bob', channelId: 'private:["test","bob"]' };
    const secret = 'sk-group-fixture123';
    const credential = scope => withBudgetScope(scope, getGroupCredential);
    const command = async (text, options = {}) => {
      const output = [];
      await handleKeyringCommand(
        { Platform: 'test', UserId: 'alice', ChannelId: 'group1', IsPrivate: false, IsAdmin: true, MessageText: text, ...options },
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
