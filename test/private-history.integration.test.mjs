import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Redis from 'ioredis';
import YAML from 'yaml';
import { getDSHConfig } from '../lib/dsh/client.js';
import { SessionRegistry } from '../lib/state/registry.js';

const withRedis = async (overrides, run) => {
  const root=await mkdtemp(join(tmpdir(),'private-history-redis-'));
  const connection=YAML.parse(await readFile(process.env.AGENT_LINK_TEST_REDIS_CONFIG,'utf8')).db.redis;
  const client=new Redis({...connection,maxRetriesPerRequest:0,retryStrategy:()=>null});
  client.on('error',()=>{});
  await client.ping();
  const previous=globalThis.ioRedis;
  globalThis.ioRedis=client;
  const config=getDSHConfig({stateBackend:'redis',workspaceRoot:join(root,'work'),dshHomeRoot:join(root,'home'),...overrides});
  assert.equal(config.stateBackend,'redis');
  try {await run(config,client);} finally {globalThis.ioRedis=previous;await client.quit();await rm(root,{recursive:true,force:true});}
};


test('Redis private history bounds, isolation, generation guard and deletion', { skip: !process.env.AGENT_LINK_TEST_REDIS_CONFIG }, () => withRedis({ privateHistoryMaxTurns: 2, privateHistoryMaxChars: 12, privateHistoryTtlSeconds: 60 }, async (config,client) => {
  const registry = new SessionRegistry(config);
  const channelId = `private:test-${randomUUID()}`;
  const reset = await registry.beginReset(channelId);
  const ctx = { channelId, generation: reset.generation };
  try {
    await registry.completeReset(channelId, reset.operationId);
    await registry.appendPrivateTurn(ctx, 'a', 'b');
    assert.ok((await client.keys('data:agent-link:group:*')).length > 0,'Redis must contain actual history keys');
    await new Promise(resolve=>setTimeout(resolve,2));
    await registry.appendPrivateTurn(ctx, 'c', 'd');
    await new Promise(resolve=>setTimeout(resolve,2));
    await registry.appendPrivateTurn(ctx, 'e', 'f');
    assert.deepEqual(
      (await registry.privateHistory(ctx)).map(m => m.content),
      ['a', 'b', 'c', 'd', 'e', 'f']
    );
    const smallBudget = new SessionRegistry({ ...config, privateHistoryMaxChars: 3 });
    assert.deepEqual(
      (await smallBudget.privateHistory(ctx)).filter(m=>m.role!=='system').map(m => m.content),
      ['e', 'f']
    );
    assert.deepEqual(await new SessionRegistry({ ...config, privateHistoryMaxTurns: 0 }).privateHistory(ctx), []);
    assert.deepEqual(await registry.privateHistory({ ...ctx, channelId: channelId + '-other' }), []);
    await registry.appendPrivateTurn(ctx, 'oversized turn', 'answer');
    const compacted=await registry.privateHistory(ctx);
    assert.match(compacted[0].content,/早前对话摘要/);
    assert.deepEqual(compacted.filter(m=>m.role!=='system').map(m=>m.content),['e','f']);
    const next = await registry.beginReset(channelId);
    const duringReset = await registry.touch(channelId, ctx.generation);
    assert.equal(duringReset.generation, next.generation);
    assert.equal(duringReset.transition, 'resetting');
    await registry.setPolicy(channelId, { version: 1, chat: true, web: false, files: false, terminal: false });
    assert.equal((await registry.meta(channelId)).transition, 'resetting');
    await registry.clearPrivateHistory(channelId);
    await registry.completeReset(channelId, next.operationId);
    await registry.appendPrivateTurn(ctx, 'stale', 'old');
    const fresh = { channelId, generation: next.generation };
    assert.deepEqual(await registry.privateHistory(fresh), []);
    const expiring = new SessionRegistry({ ...config, privateHistoryTtlSeconds: 1 });
    await expiring.appendPrivateTurn(fresh, 'new', 'ok');
    assert.deepEqual(await registry.privateHistory(ctx), []);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepEqual(await registry.privateHistory(fresh), []);
    await registry.purgeHash(await registry.groupKey(channelId));
    await registry.touch(channelId, fresh.generation);
    assert.equal((await registry.meta(channelId)).isolated, false);
    assert.equal((await registry.meta(channelId)).generation, 0);
  } finally {
    await registry.purgeHash(await registry.groupKey(channelId));
  }
}));

test(
  'explicit private memories are bounded, isolated, survive new topics, and are deletable',
  { skip: !process.env.AGENT_LINK_TEST_REDIS_CONFIG },
  () => withRedis({},async (config) => {
    const registry = new SessionRegistry(config);
    const channel = `private:memory-${randomUUID()}`;
    try {
      const first = await registry.changePrivateMemory(channel, 'add', '喜欢短回复');
      assert.equal(first.status, 'ok');
      assert.equal((await registry.changePrivateMemory(channel, 'add', '喜欢短回复')).status, 'exists');
      assert.deepEqual(await registry.privateMemories(channel + '-other'), []);
      await assert.rejects(registry.changePrivateMemory('group', 'add', '不能跨群'));
      await assert.rejects(registry.changePrivateMemory(channel, 'add', '鲸'.repeat(201)));
      const reset = await registry.beginReset(channel);
      await registry.clearPrivateHistory(channel);
      await registry.clearRecent(channel);
      await registry.completeReset(channel, reset.operationId);
      assert.equal((await registry.privateMemories(channel)).length, 1);
      const changes = await Promise.all(Array.from({ length: 25 }, (_, i) => registry.changePrivateMemory(channel, 'add', `偏好 ${i}`)));
      assert.ok(changes.some(change => change.status === 'full'));
      assert.equal((await registry.privateMemories(channel)).length, 20);
      assert.equal((await registry.changePrivateMemory(channel, 'remove', first.notes[0].id)).status, 'ok');
      assert.equal((await registry.privateMemories(channel)).length, 19);
      assert.equal((await registry.changePrivateMemory(channel, 'remove', first.notes[0].id)).status, 'missing');
      await registry.changePrivateMemory(channel, 'clear');
      assert.deepEqual(await registry.privateMemories(channel), []);
      await registry.changePrivateMemory(channel, 'add', '待清理');
      await registry.purgeHash(await registry.groupKey(channel));
      assert.deepEqual(await registry.privateMemories(channel), []);
    } finally {
      await registry.purgeHash(await registry.groupKey(channel));
    }
  })
);
