import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDSHConfig } from '../lib/dsh/client.js';
import { SessionRegistry } from '../lib/state/registry.js';

test('Redis private history bounds, isolation, generation guard and deletion', { skip: process.env.AGENT_LINK_HISTORY_INTEGRATION !== '1' }, async () => {
  const config = getDSHConfig({ 'alemonjs-agent-link': { privateHistoryMaxTurns: 2, privateHistoryMaxChars: 12, privateHistoryTtlSeconds: 60 } });
  const registry = new SessionRegistry(config);
  const channelId = `private:test-${randomUUID()}`;
  const reset = await registry.beginReset(channelId);
  const ctx = { channelId, generation: reset.generation };
  try {
    await registry.completeReset(channelId, reset.operationId);
    await registry.appendPrivateTurn(ctx, 'a', 'b');
    await registry.appendPrivateTurn(ctx, 'c', 'd');
    await registry.appendPrivateTurn(ctx, 'e', 'f');
    assert.deepEqual(
      (await registry.privateHistory(ctx)).map(m => m.content),
      ['c', 'd', 'e', 'f']
    );
    const smallBudget = new SessionRegistry({ ...config, privateHistoryMaxChars: 3 });
    assert.deepEqual(
      (await smallBudget.privateHistory(ctx)).map(m => m.content),
      ['e', 'f']
    );
    assert.deepEqual(await new SessionRegistry({ ...config, privateHistoryMaxTurns: 0 }).privateHistory(ctx), []);
    assert.deepEqual(await registry.privateHistory({ ...ctx, channelId: channelId + '-other' }), []);
    await registry.appendPrivateTurn(ctx, 'oversized turn', 'answer');
    assert.equal((await registry.privateHistory(ctx)).length, 4);
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
});
