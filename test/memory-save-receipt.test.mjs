import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requestedMemorySave } from '../lib/memory/save-intent.js';
import { ModuleRuntime, executeTool } from '../lib/agent/modules.js';
import { memoryModule } from '../lib/modules/memory.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { getMemoryStore } from '../lib/memory/store.js';

test('save intent distinguishes direct requests from quotes, questions, conditions and negation', () => {
  for (const text of [
    '记住我喜欢茶',
    '帮我记：我喜欢茶',
    '我喜欢茶这个偏好帮我记住',
    '肥鱼，帮我记一下我喜欢茶',
    '请记住：“我喜欢茶”',
    '我喜欢茶，请帮我记住',
    '以后请记住我喜欢茶',
    '能不能帮我记住这个偏好',
    'please remember I like tea',
    'could you remember that I like tea'
  ])
    assert.equal(requestedMemorySave(text), true, text);
  for (const text of [
    '“记住我喜欢茶”',
    '他说记住我喜欢茶',
    '假如我说记住，你会怎么做',
    '如果要你记住这个呢',
    '怎么让你记住我的偏好',
    '请解释记住是什么意思',
    '你能记住什么',
    'remember是什么意思',
    '记住有什么用',
    '记住我喜欢茶了吗？',
    '不要记住我喜欢茶',
    '我没让你记住这些',
    '不需要你记住',
    'please do not remember this',
    'do you remember what I said',
    '```\n记住我喜欢茶\n```',
    '就是换工作的事，这下想起来了吗'
  ])
    assert.equal(requestedMemorySave(text), false, text);
});

const context = (userText = '记住我喜欢茶') => ({
  channelId: 'private:one',
  platform: 'qq',
  userId: 'one',
  private: true,
  owner: false,
  userText,
  capabilities: { chat: true, web: false, files: false, terminal: false },
  signal: new AbortController().signal
});

test('save receipts match actual persisted records, existing records and a full store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-receipt-'));
  const config = getDSHConfig({ workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), stateBackend: 'local', retentionDays: 30 });
  const runtime = new ModuleRuntime(config, [memoryModule(config)]);
  const registry = new SessionRegistry(config);
  const lease = await runtime.acquire();
  const save = lease.tools(context()).find(tool => tool.name === 'remember_private_fact');
  try {
    const first = await executeTool(save, { text: '喜欢茶' }, context());
    assert.equal(first.ok, true);
    assert.equal(first.persistence.state, 'saved');
    assert.equal(first.persistence.retentionDays, 30);
    const stored = (await new SessionRegistry(config).privateMemories('private:one'))[0];
    assert.equal(first.persistence.recordId, stored.id);
    assert.equal(
      getMemoryStore(config)
        .list(context(), { status: 'active' })
        .some(item => item.text === '喜欢茶'),
      true
    );
    const duplicate = await executeTool(save, { text: '喜欢茶' }, context());
    assert.equal(duplicate.persistence.state, 'already_saved');
    assert.equal(duplicate.persistence.recordId, stored.id);
    assert.equal((await registry.privateMemories('private:one')).length, 1);
    const rejected = await executeTool(save, { text: '新编的资料' }, context('他说“记住我喜欢咖啡”'));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.persistence.state, 'not_saved');
    for (let i = 0; i < 19; i++) await registry.changePrivateMemory('private:one', 'add', `已有资料${i}`);
    const full = await executeTool(save, { text: '第21条' }, context('请记住这条新偏好'));
    assert.equal(full.ok, false);
    assert.equal(full.status, 'full');
    assert.equal(full.persistence.state, 'not_saved');
    assert.equal(full.persistence.recordId, undefined);
    assert.equal((await registry.privateMemories('private:one')).length, 20);
    const another = context();
    another.channelId = 'private:two';
    another.userId = 'two';
    assert.equal((await new SessionRegistry(config).privateMemories(another.channelId)).length, 0);
  } finally {
    await lease.release();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
