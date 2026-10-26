import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, getMemoryStore } from '../lib/memory/store.js';
import { ChatArchive, getChatArchive } from '../lib/history/store.js';
import { MemoryConsolidator, parseMemoryChanges } from '../lib/memory/consolidation.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { forgetMemory, synchronizeExplicitMemory } from '../lib/memory/management.js';

const scope = { platform: 'qq', channelId: 'group' };
const plan = (source, extra = {}) => ({
  action: 'add',
  text: source.text,
  kind: 'fact',
  sourceSeqs: [source.seq],
  evidence: source.text,
  tags: [],
  confidence: 0.9,
  importance: 0.5,
  ...extra
});
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'memory-consolidation-'));
  const config = getDSHConfig({
    stateBackend: 'local',
    workspaceRoot: join(root, 'workspaces'),
    dshHomeRoot: join(root, 'homes'),
    modules: { settings: { memory: { automatic: false } } }
  });
  const store = new MemoryStore(join(root, 'test-memory.sqlite'));
  const archive = new ChatArchive(join(root, 'test-history.sqlite'));
  const append = (id, text, who = 'one', role = 'user') => archive.append(scope, { id, text, speakerId: who, speaker: who, role });
  try {
    await run({ root, config, store, archive, append });
  } finally {
    store.close();
    archive.close();
    await rm(root, { recursive: true, force: true });
  }
};

test('consolidation consumes real scoped user sources, ignores commands and assistant claims, and advances its cursor', () =>
  fixture(async f => {
    f.append('one', '我喜欢喝茶');
    f.append('command', '/我是主人 123456');
    f.append('assistant', '我猜你喜欢猫', 'assistant', 'assistant');
    f.archive.append({ ...scope, channelId: 'other' }, { id: 'other', text: '跨群资料', speakerId: 'other', speaker: 'other', role: 'user' });
    let calls = 0;
    const worker = new MemoryConsolidator(f.config, {
      store: f.store,
      archive: f.archive,
      ask: async sources => {
        calls++;
        assert.equal(sources.length, 1);
        assert.equal(sources[0].text, '我喜欢喝茶');
        return [plan(sources[0])];
      }
    });
    try {
      assert.equal((await worker.consolidate(scope, true)).added, 1);
      assert.equal(f.store.profile(scope, 'one').text, '我喜欢喝茶');
      assert.equal((await worker.consolidate(scope, true)).added, 0);
      assert.equal(calls, 1);
      assert.equal(f.store.state(scope).checkpoint, f.archive.latestSeq(scope));
      f.append('two', '我现在更喜欢咖啡');
      const previous = f.store.list(scope, { status: 'active' })[0];
      const correction = new MemoryConsolidator(f.config, {
        store: f.store,
        archive: f.archive,
        ask: async (sources, old) => {
          assert.ok(old.some(item => item.id === previous.id));
          return [plan(sources[0], { action: 'replace', targetId: previous.id })];
        }
      });
      assert.equal((await correction.consolidate(scope, true)).added, 1);
      assert.equal(f.store.list(scope, { status: 'outdated' })[0].id, previous.id);
      assert.equal(f.store.profile(scope, 'one').text, '我现在更喜欢咖啡');
      correction.stop();
    } finally {
      worker.stop();
    }
  }));

test('deletion during extraction rejects the late model result and checkpoint prevents rereading forgotten history', () =>
  fixture(async f => {
    f.append('one', '我喜欢喝茶');
    let finish;
    let started;
    const ready = new Promise(resolve => {
      started = resolve;
    });
    const worker = new MemoryConsolidator(f.config, {
      store: f.store,
      archive: f.archive,
      ask: async sources => {
        started();
        return await new Promise(resolve => {
          finish = () => resolve([plan(sources[0])]);
        });
      }
    });
    try {
      const pending = worker.consolidate(scope, true);
      await ready;
      f.store.clear(scope, f.archive.latestSeq(scope));
      finish();
      assert.equal((await pending).status, 'stale');
      assert.deepEqual(f.store.list(scope), []);
      assert.equal((await worker.consolidate(scope, true)).added, 0);
    } finally {
      finish?.();
      worker.stop();
    }
  }));

test('backlog processing does not jump over unprocessed source records and stopping aborts active work', () =>
  fixture(async f => {
    for (let i = 0; i < 45; i++) f.append(String(i), `记录 ${i}`);
    const sizes = [];
    const worker = new MemoryConsolidator(f.config, {
      store: f.store,
      archive: f.archive,
      ask: async sources => {
        sizes.push(sources.length);
        return [];
      }
    });
    assert.equal((await worker.consolidate(scope, true)).hasMore, true);
    assert.equal(f.store.state(scope).checkpoint, 40);
    assert.equal((await worker.consolidate(scope, true)).hasMore, false);
    assert.deepEqual(sizes, [40, 5]);
    worker.stop();
    f.append('new', '新的记录');
    let started;
    const ready = new Promise(resolve => {
      started = resolve;
    });
    const abortable = new MemoryConsolidator(f.config, {
      store: f.store,
      archive: f.archive,
      ask: async (_sources, _old, signal) => {
        started();
        return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    });
    const pending = abortable.consolidate(scope, true);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await ready;
    abortable.stop();
    await rejected;
    assert.deepEqual(f.store.list(scope), []);
  }));

test('invalid extraction payloads are rejected and archive-disabled prevents even manual model requests', () =>
  fixture(async f => {
    for (const value of [
      { changes: [{ ...plan({ seq: 1, text: '喜欢茶' }), confidence: 2 }] },
      { changes: [{ ...plan({ seq: 1, text: '喜欢茶' }), targetId: '12345678' }] },
      { changes: [{ ...plan({ seq: 1, text: '喜欢茶' }), sourceSeqs: [] }] },
      { changes: [], unexpected: 'instruction' }
    ])
      assert.throws(() => parseMemoryChanges(JSON.stringify(value)));
    f.append('one', '喜欢茶');
    const worker = new MemoryConsolidator(
      { ...f.config, modules: { disabled: ['chat-history'] } },
      { store: f.store, archive: f.archive, ask: async () => assert.fail('disabled archive read') }
    );
    assert.equal((await worker.consolidate(scope, true)).status, 'archive-disabled');
    worker.stop();
  }));

test('explicit memory deletion clears canonical duplicates in both stores and cannot be restored by synchronization', () =>
  fixture(async f => {
    const privateScope = { platform: 'qq', channelId: 'private:one' };
    const registry = new SessionRegistry(f.config);
    await registry.changePrivateMemory(privateScope.channelId, 'add', '喜欢喝茶');
    await registry.changePrivateMemory(privateScope.channelId, 'add', '喜欢喝茶！');
    await synchronizeExplicitMemory(f.config, privateScope, 'one');
    const store = getMemoryStore(f.config);
    const id = store.list(privateScope)[0].id;
    assert.equal(store.list(privateScope).length, 2);
    assert.equal(await forgetMemory(f.config, privateScope, 'one', id), 'ok');
    assert.deepEqual(await registry.privateMemories(privateScope.channelId), []);
    await synchronizeExplicitMemory(f.config, privateScope, 'one');
    assert.deepEqual(store.list(privateScope), []);
    await registry.changePrivateMemory(privateScope.channelId, 'add', '新偏好');
    await synchronizeExplicitMemory(f.config, privateScope, 'one');
    getChatArchive(f.config).append(privateScope, { id: 'source', text: '新偏好', speakerId: 'one', speaker: 'one', role: 'user' });
    const before = store.state(privateScope);
    await forgetMemory(f.config, privateScope, 'one');
    assert.ok(store.state(privateScope).revision > before.revision);
    assert.equal(store.state(privateScope).checkpoint, getChatArchive(f.config).latestSeq(privateScope));
  }));
