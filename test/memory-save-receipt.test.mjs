import { conversationQueueScope } from '../lib/dsh/conversation-scope.js';
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
    '记住这个词：回声港',
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
    'can you remember what I told you',
    "'记住我喜欢茶'",
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
    const stored = (await new SessionRegistry(config).privateMemories('private:one', conversationQueueScope(config, context())))[0];
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
    assert.equal((await registry.privateMemories('private:one', conversationQueueScope(config, context()))).length, 1);
    const rejected = await executeTool(save, { text: '新编的资料' }, context('他说“记住我喜欢咖啡”'));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.persistence.state, 'not_saved');
    for (let i = 0; i < 19; i++) await registry.changePrivateMemory('private:one', 'add', `已有资料${i}`, undefined, conversationQueueScope(config, context()));
    const full = await executeTool(save, { text: '第21条' }, context('请记住这条新偏好'));
    assert.equal(full.ok, false);
    assert.equal(full.status, 'full');
    assert.equal(full.persistence.state, 'not_saved');
    assert.equal(full.persistence.recordId, undefined);
    assert.equal((await registry.privateMemories('private:one', conversationQueueScope(config, context()))).length, 20);
    const another = context();
    another.channelId = 'private:two';
    another.userId = 'two';
    assert.equal((await new SessionRegistry(config).privateMemories(another.channelId, conversationQueueScope(config, another))).length, 0);
  } finally {
    await lease.release();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unavailable save request buffers streaming and replaces only a plain request echo', async () => {
  const { bufferUnavailableMemorySave, resolveUnavailableMemoryEcho } = await import('../lib/memory/save-reply.js');
  assert.equal(bufferUnavailableMemorySave(true, '请记住我喜欢茶', []), true);
  assert.equal(bufferUnavailableMemorySave(true, '请记住我喜欢茶', [{ name: 'remember_private_fact' }]), false);
  assert.equal(bufferUnavailableMemorySave(false, '请记住我喜欢茶', []), false);
  assert.equal(bufferUnavailableMemorySave(true, '他说“记住我喜欢茶”', []), false);
  assert.match(resolveUnavailableMemoryEcho('\n\nuser请记住我喜欢茶', '请记住我喜欢茶'), /没能确认长期保存/);
  const actual = '这次还没有保存。';
  assert.equal(resolveUnavailableMemoryEcho(actual, '请记住我喜欢茶'), actual);
});

test('the actual turn never streams an echoed save request when memory tools are disabled', async () => {
  const { runModuleTurn } = await import('../lib/agent/turn.js');
  const { getModuleRuntime } = await import('../lib/agent/modules.js');
  const root = await mkdtemp(join(tmpdir(), 'memory-disabled-echo-'));
  const previous = { config: globalThis.__config, fetch: globalThis.fetch };
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        budget: { enabled: false },
        modules: { disabled: ['memory', 'mood', 'opinions', 'proactive', 'affinity', 'events'] }
      }
    }
  };
  const config = getDSHConfig();
  const text = '请记住我喜欢普洱茶';
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, false);
    assert.equal(body.tools, undefined);
    return Response.json({ choices: [{ message: { content: `\n\nuser${text}` } }] });
  };
  try {
    await runModuleTurn({
      config,
      sessionId: 'disabled-memory-test',
      input: text,
      context: { ...context(text), allowedTools: [] },
      streamContent: true,
      onEvent: event => {
        if (event.type === 'content') sent.push(event.content);
        return Promise.resolve();
      }
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /没能确认长期保存/);
    assert.ok(!sent[0].includes(`user${text}`));
    assert.equal((await new SessionRegistry(config).privateMemories('private:one', conversationQueueScope(config, context()))).length, 0);
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = previous.config;
    globalThis.fetch = previous.fetch;
    await rm(root, { recursive: true, force: true });
  }
});
