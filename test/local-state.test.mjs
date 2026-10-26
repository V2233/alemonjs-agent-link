import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getDSHConfig as getConfig } from '../lib/dsh/client.js';
import { SessionRegistry } from '../lib/state/registry.js';

const root = await mkdtemp(join(tmpdir(), 'agent-link-local-'));
const getDSHConfig = (value = {}) =>
  getConfig({ 'alemonjs-agent-link': { ...value['alemonjs-agent-link'], stateBackend: 'local', dshHomeRoot: join(root, 'homes') } });

test('Local private history bounds, isolation, generation guard and deletion', {}, async () => {
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

test('explicit private memories are bounded, isolated, survive new topics, and are deletable', {}, async () => {
  const config = getDSHConfig({});
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
});

test('sticker cooldown is shared across requests and removed with conversation data', {}, async () => {
  const registry = new SessionRegistry(getDSHConfig({}));
  const channel = `private:sticker-${randomUUID()}`;
  try {
    const claims = await Promise.all(Array.from({ length: 5 }, () => registry.claimSticker(channel, 30)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await registry.claimSticker(channel, 0), true);
    await registry.purgeHash(await registry.groupKey(channel));
    assert.equal(await registry.claimSticker(channel, 30), true);
  } finally {
    await registry.purgeHash(await registry.groupKey(channel));
  }
});

test('single-owner deduplication, compare-and-delete, rate limit and durable snapshot', async () => {
  const registry = new SessionRegistry(getDSHConfig());
  const channel = randomUUID();
  const results = await Promise.all(Array.from({ length: 20 }, () => registry.deduplicate(channel, 'one')));
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  const owner = results.find(result => !result.duplicate);
  await registry.releaseDeduplication(channel, 'one', 'wrong-owner');
  assert.equal((await registry.deduplicate(channel, 'one')).duplicate, true);
  assert.equal(await registry.finalizeDeduplication(channel, 'one', owner.requestId), true);
  await registry.releaseDeduplication(channel, 'one', owner.requestId);
  assert.equal((await registry.deduplicate(channel, 'one')).duplicate, true);
  const rate = await Promise.all(Array.from({ length: 10 }, () => registry.allowUser(channel, 'user')));
  assert.equal(rate.filter(Boolean).length, 6);
  assert.equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).version, 1);
});

test('local state survives process restart and rejects simultaneous owners', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'agent-link-persist-')), 'state.json');
  const module = new URL('../lib/state/local-store.js', import.meta.url).href;
  const run = body =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { getLocalStore } from ${JSON.stringify(module)}; const store = await getLocalStore(${JSON.stringify(path)}); ${body}`
      ],
      { encoding: 'utf8' }
    );
  assert.equal(run("await store.set('test', 'saved');").status, 0);
  const read = run("console.log(await store.get('test'));");
  assert.equal(read.status, 0);
  assert.match(read.stdout, /saved/);
  const crashed = run("await store.set('test', 'after-crash'); process.kill(process.pid, 'SIGKILL');");
  assert.notEqual(crashed.status, 0);
  const recovered = run("console.log(await store.get('test'));");
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /after-crash/);
  await writeFile(`${path}.lock`, String(process.pid));
  const blocked = run('');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /另一个进程/);
});

test('backend selection preserves explicit Redis deployments and validates sources', () => {
  assert.equal(getConfig({}).stateBackend, 'local');
  assert.equal(getConfig({ db: { redis: { host: 'localhost' } } }).stateBackend, 'redis');
  assert.equal(getConfig({ db: { redis: {} }, 'alemonjs-agent-link': { stateBackend: 'local' } }).stateBackend, 'local');
  for (const pythonPackageSources of [[], ['http://unsafe/simple'], ['https://user:password@example.com/simple']]) {
    assert.throws(() => getConfig({ 'alemonjs-agent-link': { pythonPackageSources } }));
  }
});
