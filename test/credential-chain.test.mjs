import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { saveAccount } from '../lib/credentials/account.js';
import { changeKeyring, readKeyring, grantIsCurrent } from '../lib/credentials/keyring.js';
import { setGroupKeyState, groupKeyStatus, groupStorageKey, resolveGrantScope } from '../lib/credentials/group.js';
import { bindPersonalKey, updatePersonalKey, encryptStoredKey } from '../lib/credentials/personal.js';
import { getBoundCredential, checkedBoundCredential } from '../lib/credentials/scoped.js';
import { withBudgetScope, budgetedFetch, budgetStatus } from '../lib/billing/budget.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';

test(
  'shared pool → caller credential → free quota, with independent ownership and background isolation',
  { skip: !process.env.AGENT_LINK_TEST_REDIS_SERVER },
  async t => {
    const dir = await mkdtemp(join(tmpdir(), 'credential-chain-'));
    const socket = join(dir, 'redis.sock');
    const server = spawn(process.env.AGENT_LINK_TEST_REDIS_SERVER, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], {
      stdio: 'ignore'
    });
    const redis = new Redis({ path: socket, retryStrategy: () => 20 });
    redis.on('error', () => {});
    const previous = { redis: globalThis.ioRedis, config: globalThis.__config, fetch: globalThis.fetch, key: process.env.AGENT_LINK_PERSONAL_KEY_FILE };
    const own = userId => ({ platform: 'test', userId, channelId: `private:${JSON.stringify(['test', userId])}` });
    const group = { ...own('caller'), channelId: 'group' };
    const config = resolveDSHConfig({ budget: { enabled: true, personalDailyYuan: 1 }, runtimeMode: 'chat-only' });
    let calls = [],
      depleted = new Set(),
      failure;
    const request = (scope = group, kind = 'chat') =>
      withBudgetScope(scope, async () => {
        const response = await budgetedFetch(
          config,
          new URL('https://api.deepseek.com/chat/completions'),
          {
            method: 'POST',
            headers: { Authorization: 'Bearer sk-robot-fixture' },
            body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }] })
          },
          kind
        );
        await response.text();
        return response.status;
      });
    try {
      await Promise.race([redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('Redis startup timeout')), 5000).unref())]);
      globalThis.ioRedis = redis;
      globalThis.__config = { value: { db: { redis: { path: socket } }, 'alemonjs-agent-link': { aiEnabled: true, apiKey: 'sk-robot-fixture' } } };
      process.env.AGENT_LINK_PERSONAL_KEY_FILE = join(dir, 'key');
      globalThis.fetch = async (url, init) => {
        const h = new Headers(init.headers);
        const token = h.get('x-dsh-auth-token') || h.get('Authorization')?.replace('Bearer ', '');
        if (String(url).endsWith('/user/balance')) return Response.json({ is_available: !depleted.has(token) });
        assert.ok(!(h.has('x-dsh-auth-token') && h.has('Authorization')));
        calls.push(token);
        if (failure) throw new Error(failure);
        if (depleted.has(token)) return new Response('{}', { status: 402 });
        return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      };
      const a = await saveAccount(own('a'), 'shared-a');
      const b = await saveAccount(own('b'), 'shared-b');
      await saveAccount(own('caller'), 'personal-caller');
      await changeKeyring({ ...group, userId: 'a' }, 'grant', String(a));
      await changeKeyring({ ...group, userId: 'b' }, 'grant', String(b));
      await t.test('multiple administrators contribute without overwriting and duplicate sharing is rejected', async () => {
        assert.equal((await groupKeyStatus(group)).count, 2);
        await Promise.all([
          changeKeyring({ ...group, channelId: 'concurrent', userId: 'a' }, 'grant', String(a)),
          changeKeyring({ ...group, channelId: 'concurrent', userId: 'b' }, 'grant', String(b))
        ]);
        assert.equal((await groupKeyStatus({ ...group, channelId: 'concurrent' })).count, 2);
        await assert.rejects(changeKeyring({ ...group, userId: 'a' }, 'grant', String(a)), /已分享/);
        assert.equal((await withBudgetScope(group, getBoundCredential)).apiKey, 'shared-a');
      });
      await t.test('all group members use shared keys, then only the caller own key', async () => {
        depleted = new Set(['shared-a']);
        calls = [];
        assert.equal(await request(), 200);
        assert.deepEqual(calls, ['shared-a', 'shared-b']);
        depleted.add('shared-b');
        calls = [];
        assert.equal(await request(), 200);
        assert.deepEqual(calls, ['shared-b', 'personal-caller']);
        assert.equal((await budgetStatus(config, group)).personalUsed, 0);
        assert.equal(await withBudgetScope({ ...group, userId: 'stranger' }, getBoundCredential), null);
      });
      await t.test('personal 402 falls back to caller free ledger; subsequent private calls use the same free ledger', async () => {
        depleted.add('personal-caller');
        calls = [];
        await request();
        assert.deepEqual(calls, ['personal-caller', 'sk-robot-fixture']);
        const used = (await budgetStatus(config, group)).personalUsed;
        assert.ok(used > 0);
        calls = [];
        await request(own('caller'));
        assert.deepEqual(calls, ['sk-robot-fixture']);
        assert.ok((await budgetStatus(config, own('caller'))).personalUsed > used);
      });
      await t.test('network uncertainty does not retry or change the payer', async () => {
        await setGroupKeyState(group, true);
        depleted.clear();
        calls = [];
        failure = 'network unavailable';
        await assert.rejects(request(), /network unavailable/);
        assert.deepEqual(calls, ['shared-a']);
        failure = undefined;
        assert.equal((await groupKeyStatus(group)).active, 2);
      });
      await t.test('background work cannot borrow the triggering user personal credential', async () => {
        await setGroupKeyState(group, false);
        await updatePersonalKey(own('caller'), 'enable');
        assert.equal(await withBudgetScope({ ...group, autonomous: true }, getBoundCredential), null);
        assert.equal(await withBudgetScope(group, () => checkedBoundCredential(undefined, true)), null);
        calls = [];
        await request(group, 'reply-gate');
        assert.deepEqual(calls, ['sk-robot-fixture']);
      });
      await t.test('confirmed API-key depletion also falls back without model dispatch on that key', async () => {
        await bindPersonalKey(own('caller'), 'sk-personal-fixture');
        depleted.add('sk-personal-fixture');
        calls = [];
        await request();
        assert.deepEqual(calls, ['sk-robot-fixture']);
      });
      await t.test('revoking one donor preserves the other, and legacy grants remain revocable', async () => {
        const ga = (await readKeyring(own('a'))).ring.grants[0];
        const gb = (await readKeyring(own('b'))).ring.grants[0];
        await changeKeyring(own('a'), 'revoke', String(ga.id));
        assert.equal((await groupKeyStatus(group)).count, 1);
        assert.equal(await grantIsCurrent(own('b'), gb), true);
        // Simulate an installation predating per-grant storage; its encryption AAD uses the root key.
        const target = await resolveGrantScope(group, gb.token);
        const record = JSON.parse(await redis.get(groupStorageKey(target)));
        record.encrypted = await encryptStoredKey(groupStorageKey(group), 'shared-b');
        await redis.set(groupStorageKey(group), JSON.stringify(record));
        await redis.del(groupStorageKey(target));
        assert.equal(await grantIsCurrent(own('b'), gb), true);
        await changeKeyring(own('b'), 'revoke', String(gb.id));
        assert.equal((await groupKeyStatus(group)).count, 0);
        assert.equal(await redis.llen(`${groupStorageKey(group)}:pool`), 0);
      });
    } finally {
      globalThis.ioRedis = previous.redis;
      globalThis.__config = previous.config;
      globalThis.fetch = previous.fetch;
      if (previous.key === undefined) delete process.env.AGENT_LINK_PERSONAL_KEY_FILE;
      else process.env.AGENT_LINK_PERSONAL_KEY_FILE = previous.key;
      redis.disconnect();
      const stopped = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await stopped;
      await rm(dir, { recursive: true, force: true });
    }
  }
);
