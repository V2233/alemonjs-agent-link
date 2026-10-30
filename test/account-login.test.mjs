import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { saveAccount, getAccount, removeAccount } from '../lib/credentials/account.js';
import { readKeyring, changeKeyring } from '../lib/credentials/keyring.js';
import { getPersonalCredential, updatePersonalKey, bindPersonalKey, personalStorageKey } from '../lib/credentials/personal.js';
import { getGroupCredential } from '../lib/credentials/group.js';
import { withBudgetScope, budgetedFetch } from '../lib/billing/budget.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';
test('scan prepares two purposes once; private switches and group grants are independent', { skip: !process.env.AGENT_LINK_TEST_REDIS_SERVER }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-keyring-')),
    socket = join(dir, 'redis.sock');
  const server = spawn(process.env.AGENT_LINK_TEST_REDIS_SERVER, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore'
  });
  const redis = new Redis({ path: socket, retryStrategy: () => 20 });
  redis.on('error', () => {});
  const previous = { redis: globalThis.ioRedis, config: globalThis.__config, key: process.env.AGENT_LINK_PERSONAL_KEY_FILE, fetch: globalThis.fetch };
  const own = { platform: 'test', userId: 'alice', channelId: 'private:["test","alice"]' };
  const group = { ...own, channelId: 'g1' },
    group2 = { ...own, channelId: 'g2' };
  try {
    await Promise.race([redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('Redis startup timeout')), 5000).unref())]);
    globalThis.ioRedis = redis;
    globalThis.__config = { value: { db: { redis: { path: socket } }, 'alemonjs-agent-link': {} } };
    process.env.AGENT_LINK_PERSONAL_KEY_FILE = join(dir, 'key');
    const id = await saveAccount(own, 'fixture-token');
    const ring = await readKeyring(own);
    assert.equal(ring.ring.keys.length, 1);
    assert.equal(ring.ring.grants.length, 0);
    assert.equal(ring.raw.includes('fixture-token'), false);
    assert.equal((await redis.get(personalStorageKey(own))).includes('fixture-token'), false);
    assert.equal((await withBudgetScope(own, getPersonalCredential)).auth, 'account');
    assert.equal(await withBudgetScope(group, getGroupCredential), null);
    await assert.rejects(saveAccount(own, 'duplicate'), /already/);
    assert.equal((await readKeyring(own)).ring.keys.length, 1);
    await updatePersonalKey(own, 'disable');
    assert.equal(await withBudgetScope(own, getPersonalCredential), null);
    await changeKeyring(group, 'grant', String(id));
    await changeKeyring(group2, 'grant', String(id));
    assert.equal((await withBudgetScope(group, getGroupCredential)).auth, 'account');
    assert.equal((await withBudgetScope(group2, getGroupCredential)).apiKey, 'fixture-token');
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
      const h = new Headers(init.headers);
      assert.equal(h.get('authorization'), null);
      assert.equal(h.get('x-dsh-auth-token'), 'fixture-token');
      return new Response('{}', { status: 402 });
    };
    await assert.rejects(
      withBudgetScope(group, () =>
        budgetedFetch(resolveDSHConfig({ budget: { enabled: false } }), new URL('https://example.com'), {
          method: 'POST',
          body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] })
        })
      ),
      /机器人未配置模型凭证/
    );
    assert.equal(calls, 1);
    const grant = (await readKeyring(own)).ring.grants.find(g => g.channelId === 'g1');
    await changeKeyring(own, 'revoke', String(grant.id));
    assert.equal(await withBudgetScope(group, getGroupCredential), null);
    assert.ok(await withBudgetScope(group2, getGroupCredential));
    assert.ok(await getAccount(own));
    await updatePersonalKey(own, 'remove');
    assert.ok(await withBudgetScope(group2, getGroupCredential));
    await bindPersonalKey(own, 'sk-existing-private123');
    globalThis.fetch = async () => Response.json({ code: 0, data: { biz_code: 0 } });
    await removeAccount(own);
    assert.equal(await getAccount(own), null);
    assert.equal(await withBudgetScope(group2, getGroupCredential), null);
    assert.equal((await withBudgetScope(own, getPersonalCredential)).apiKey, 'sk-existing-private123');
    await saveAccount(own, 'new-scan-token');
    assert.equal((await withBudgetScope(own, getPersonalCredential)).apiKey, 'sk-existing-private123');
    assert.equal((await readKeyring(own)).ring.keys.length, 1);
    assert.equal((await readKeyring(own)).ring.grants.length, 0);
  } finally {
    globalThis.fetch = previous.fetch;
    globalThis.ioRedis = previous.redis;
    globalThis.__config = previous.config;
    if (previous.key === undefined) delete process.env.AGENT_LINK_PERSONAL_KEY_FILE;
    else process.env.AGENT_LINK_PERSONAL_KEY_FILE = previous.key;
    redis.disconnect();
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
