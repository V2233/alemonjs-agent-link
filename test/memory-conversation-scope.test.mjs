import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDSHConfig } from '../lib/dsh/client.js';
import { conversationQueueScope } from '../lib/dsh/conversation-scope.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { MemoryStore, getMemoryStore } from '../lib/memory/store.js';
import { ChatArchive, getChatArchive } from '../lib/history/store.js';
import { synchronizeExplicitMemory, forgetMemory } from '../lib/memory/management.js';
import { MemoryConsolidator } from '../lib/memory/consolidation.js';
import { MemoryQueryContext } from '../lib/memory/query-context.js';
import { ModuleRuntime, executeTool } from '../lib/agent/modules.js';
import { memoryModule } from '../lib/modules/memory.js';

const a = { platform: 'onebot', botId: 'a', channelId: 'private:user' };
const b = { ...a, botId: 'b' };
const message = (text, speakerId = 'user') => ({ id: text, text, speakerId, speaker: speakerId, role: 'user' });
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'memory-scope-'));
  const config = name =>
    getDSHConfig({
      stateBackend: 'local',
      workspaceRoot: join(root, `work-${name}`),
      dshHomeRoot: join(root, `home-${name}`),
      budget: { enabled: false },
      modules: { settings: { memory: { automatic: false } } }
    });
  const first = config('first'),
    second = config('second');
  const stores = [getMemoryStore(first), getMemoryStore(second)];
  const archives = [getChatArchive(first), getChatArchive(second)];
  try {
    await run({ root, first, second, stores, archives });
  } finally {
    for (const store of stores) store.close();
    for (const archive of archives) archive.close();
    await rm(root, { recursive: true, force: true });
  }
};

test('explicit notes isolate bot/platform/root; correction and deletion cannot change another identity', () =>
  fixture(async ({ first, second, stores }) => {
    const registry = new SessionRegistry(first),
      other = new SessionRegistry(second);
    const scope = identity => conversationQueueScope(first, identity);
    const saved = await registry.changePrivateMemory(a.channelId, 'add', '__A_NOTE__', undefined, scope(a));
    const id = saved.notes[0].id;
    assert.deepEqual(await registry.privateMemories(a.channelId, scope(b)), []);
    assert.deepEqual(await registry.privateMemories(a.channelId, scope({ ...a, platform: 'other' })), []);
    assert.deepEqual(await other.privateMemories(a.channelId, conversationQueueScope(second, a)), []);
    assert.equal((await registry.changePrivateMemory(a.channelId, 'replace', 'wrong', { id, expectedText: '__A_NOTE__' }, scope(b))).status, 'missing');
    await registry.changePrivateMemory(a.channelId, 'clear', '', undefined, scope(b));
    assert.equal((await registry.privateMemories(a.channelId, scope(a)))[0].text, '__A_NOTE__');
    await synchronizeExplicitMemory(first, a, 'user');
    assert.equal(stores[0].list(a)[0].text, '__A_NOTE__');
    assert.deepEqual(stores[0].list(b), []);
    await forgetMemory(first, b, 'user');
    assert.equal(stores[0].list(a).length, 1);
    await forgetMemory(first, a, 'user', id);
    await synchronizeExplicitMemory(first, a, 'user');
    assert.deepEqual(stores[0].list(a), []);
    assert.deepEqual(await registry.privateMemories(a.channelId, scope(a)), []);
  }));

test('shared SQLite files isolate namespaces, due jobs, group speakers, receipts and deletion', () =>
  fixture(async ({ first, stores: [store, other], archives: [archive, otherArchive] }) => {
    const group = { ...a, channelId: 'group' };
    for (const [target, text] of [
      [store, '__FIRST__'],
      [other, '__SECOND__']
    ])
      target.recordExperience(group, { tags: [], key: 'same', subjectId: 'a', text });
    archive.append(group, message('__ALICE__', 'alice'));
    archive.append(group, message('__BOB__', 'bob'));
    otherArchive.append(group, message('__OTHER_ROOT__'));
    assert.equal(store.list(group)[0].text, '__FIRST__');
    assert.equal(other.list(group)[0].text, '__SECOND__');
    assert.deepEqual(store.list({ ...group, botId: 'b' }), []);
    assert.deepEqual(archive.search({ ...group, botId: 'b' }).items, []);
    assert.deepEqual(archive.search({ ...group, platform: 'other' }).items, []);
    const batch = archive.readGroupInbox(group, 'a');
    assert.deepEqual(
      batch.sources.map(row => row.speakerId),
      ['alice', 'bob']
    );
    assert.equal(archive.acknowledgeGroupInbox({ ...group, botId: 'b' }, 'a', batch.receipt).ok, false);
    assert.equal(otherArchive.acknowledgeGroupInbox(group, 'a', batch.receipt).ok, false);
    assert.equal(archive.acknowledgeGroupInbox(group, 'a', batch.receipt).ok, true);
    assert.deepEqual(store.due(0), [group]);
    assert.deepEqual(other.due(0), [group]);
    archive.invalidate({ ...group, botId: 'b' }, '__ALICE__');
    assert.equal(archive.findMessage(group, '__ALICE__').speakerId, 'alice');
    const hash = createHash('sha256').update(group.channelId).digest('hex');
    store.purgeHash(hash);
    archive.purgeHash(hash);
    assert.deepEqual(store.list(group), []);
    assert.deepEqual(archive.search(group).items, []);
    assert.equal(other.list(group)[0].text, '__SECOND__');
    assert.equal(otherArchive.search(group).items[0].text, '__OTHER_ROOT__');
    assert.equal(getMemoryStore(first), store);
  }));

test('retention cleanup touches only its namespace even when databases share a parent directory', () =>
  fixture(async ({ root, stores: [store, other], archives: [archive, otherArchive] }) => {
    store.recordExperience(a, { tags: [], key: 'old', subjectId: 'a', text: '__FIRST__' });
    other.recordExperience(a, { tags: [], key: 'old', subjectId: 'a', text: '__SECOND__' });
    archive.append(a, message('__FIRST__'));
    otherArchive.append(a, message('__SECOND__'));
    const memoryDb = new DatabaseSync(join(root, 'memories.sqlite')),
      historyDb = new DatabaseSync(join(root, 'chat-history.sqlite'));
    try {
      const old = Date.now() - 31 * 86400000;
      memoryDb.prepare('UPDATE memory_scopes SET active_at=?').run(old);
      historyDb.prepare('UPDATE messages SET timestamp=?').run(old);
      store.cleanup(30);
      archive.cleanup();
      assert.equal(memoryDb.prepare('SELECT count(*) AS n FROM memory_scopes').get().n, 1);
      assert.equal(historyDb.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
      assert.deepEqual(store.due(0), []);
      assert.deepEqual(other.due(0), [a]);
    } finally {
      memoryDb.close();
      historyDb.close();
    }
  }));

test('old schema and raw private notes stay unassigned instead of being imported to a bot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-upgrade-'));
  const config = getDSHConfig({ workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), stateBackend: 'local' });
  const legacy = { platform: a.platform, channelId: a.channelId };
  const memoryPath = join(root, 'memories.sqlite'),
    historyPath = join(root, 'chat-history.sqlite');
  let oldMemory = new MemoryStore(memoryPath),
    oldArchive = new ChatArchive(historyPath),
    modernMemory,
    modernArchive;
  try {
    oldMemory.recordExperience(legacy, { tags: [], key: 'legacy', subjectId: 'user', text: '__LEGACY_MEMORY__' });
    oldArchive.append(legacy, message('__LEGACY_ARCHIVE__'));
    oldMemory.close();
    oldMemory = undefined;
    oldArchive.close();
    oldArchive = undefined;
    const db = new DatabaseSync(memoryPath);
    db.exec('DROP INDEX memory_namespace; ALTER TABLE memory_scopes DROP COLUMN bot_id; ALTER TABLE memory_scopes DROP COLUMN data_namespace');
    db.close();
    const historyDb = new DatabaseSync(historyPath);
    historyDb.exec('DROP TABLE history_scopes');
    historyDb.close();
    const registry = new SessionRegistry(config);
    await registry.changePrivateMemory(a.channelId, 'add', '__LEGACY_NOTE__');
    modernMemory = getMemoryStore(config);
    modernArchive = getChatArchive(config);
    assert.deepEqual(modernMemory.list(a), []);
    assert.deepEqual(modernMemory.due(0), []);
    assert.deepEqual(modernArchive.search(a).items, []);
    assert.deepEqual(await registry.privateMemories(a.channelId, conversationQueueScope(config, a)), []);
    await synchronizeExplicitMemory(config, a, 'user');
    assert.deepEqual(modernMemory.list(a), []);
    assert.equal((await registry.privateMemories(a.channelId))[0].text, '__LEGACY_NOTE__');
    oldMemory = new MemoryStore(memoryPath);
    oldArchive = new ChatArchive(historyPath);
    assert.equal(oldMemory.list(legacy)[0].text, '__LEGACY_MEMORY__');
    assert.equal(oldArchive.search(legacy).items[0].text, '__LEGACY_ARCHIVE__');
  } finally {
    oldMemory?.close();
    oldArchive?.close();
    modernMemory?.close();
    modernArchive?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('consolidation reads only its bot archive and keeps group facts attributed to each speaker', () =>
  fixture(async ({ first, stores: [store], archives: [archive] }) => {
    const group = { ...a, channelId: 'group' };
    archive.append(group, message('我喜欢茶', 'alice'));
    archive.append(group, message('我喜欢咖啡', 'bob'));
    archive.append({ ...group, botId: 'b' }, message('__B_SECRET__'));
    const worker = new MemoryConsolidator(first, {
      store,
      archive,
      ask: async sources => {
        assert.deepEqual(
          sources.map(source => source.speakerId),
          ['alice', 'bob']
        );
        return sources.map(source => ({
          action: 'add',
          text: source.text,
          kind: 'fact',
          sourceSeqs: [source.seq],
          evidence: source.text,
          tags: [],
          confidence: 0.9,
          importance: 0.5
        }));
      }
    });
    try {
      assert.equal((await worker.consolidate(group, true)).added, 2);
      assert.equal(store.profile(group, 'alice').text, '我喜欢茶');
      assert.equal(store.profile(group, 'bob').text, '我喜欢咖啡');
      assert.deepEqual(store.list({ ...group, botId: 'b' }), []);
    } finally {
      worker.stop();
    }
  }));

test('real memory module context and tools cannot recall another bot private notes', () =>
  fixture(async ({ first }) => {
    const registry = new SessionRegistry(first);
    await registry.changePrivateMemory(a.channelId, 'add', '__A_PRIVATE__', undefined, conversationQueueScope(first, a));
    const runtime = new ModuleRuntime(first, [memoryModule(first)]),
      lease = await runtime.acquire();
    const context = { ...b, userId: 'user', private: true, owner: false, userText: '记住我喜欢咖啡', signal: new AbortController().signal };
    try {
      assert.ok(!(await lease.context(context)).includes('__A_PRIVATE__'));
      const recall = lease.tools(context).find(tool => tool.name === 'recall_private_memory');
      assert.deepEqual((await executeTool(recall, {}, context)).notes, []);
      const save = lease.tools(context).find(tool => tool.name === 'remember_private_fact');
      assert.equal((await executeTool(save, { text: '喜欢咖啡' }, context)).ok, true);
      assert.equal((await registry.privateMemories(a.channelId, conversationQueueScope(first, a)))[0].text, '__A_PRIVATE__');
      assert.equal((await executeTool(recall, {}, context)).notes[0].text, '喜欢咖啡');
    } finally {
      await lease.release();
      await runtime.close();
    }
  }));

test('short follow-up queries never borrow another bot question', () => {
  const queries = new MemoryQueryContext();
  queries.resolve({ ...a, userId: 'user' }, '我的工作是什么');
  assert.equal(queries.resolve({ ...b, userId: 'user' }, '继续'), '继续');
  assert.equal(queries.resolve({ ...a, userId: 'user' }, '继续'), '我的工作是什么 继续');
});

test('separate Node processes recover their scoped durable notes and SQLite data after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-restart-'));
  const imports = name => new URL(`../lib/${name}.js`, import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import {getDSHConfig} from ${JSON.stringify(imports('dsh/client'))};
    import {conversationQueueScope} from ${JSON.stringify(imports('dsh/conversation-scope'))};
    import {SessionRegistry} from ${JSON.stringify(imports('state/registry'))};
    import {getMemoryStore} from ${JSON.stringify(imports('memory/store'))};
    import {getChatArchive} from ${JSON.stringify(imports('history/store'))};
    const [root, mode] = process.argv.slice(1);
    const config = getDSHConfig({workspaceRoot:root+'/work',dshHomeRoot:root+'/home',stateBackend:'local'});
    const a = {platform:'onebot',botId:'a',channelId:'private:user'}, b = {...a,botId:'b'};
    const registry = new SessionRegistry(config), memory = getMemoryStore(config), archive = getChatArchive(config);
    try {
      if(mode==='seed') {
        await registry.changePrivateMemory(a.channelId,'add','__DURABLE_NOTE__',undefined,conversationQueueScope(config,a));
        memory.recordExperience(a,{key:'one',subjectId:'a',tags:[],text:'__DURABLE_MEMORY__'});
        archive.append(a,{id:'one',speakerId:'user',speaker:'user',role:'user',text:'__DURABLE_ARCHIVE__'});
      }
      assert.equal((await registry.privateMemories(a.channelId,conversationQueueScope(config,a)))[0].text,'__DURABLE_NOTE__');
      assert.equal(memory.list(a)[0].text,'__DURABLE_MEMORY__');
      assert.equal(archive.search(a).items[0].text,'__DURABLE_ARCHIVE__');
      assert.deepEqual(await registry.privateMemories(b.channelId,conversationQueueScope(config,b)),[]);
      assert.deepEqual(memory.list(b),[]); assert.deepEqual(archive.search(b).items,[]);
    } finally {memory.close();archive.close();}
    console.log('SCOPE_RESTART_OK'); process.exit(0);
  `;
  try {
    for (const mode of ['seed', 'read']) {
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, root, mode], { timeout: 15000 });
      assert.ok(result.stdout.includes('SCOPE_RESTART_OK'));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
