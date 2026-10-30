import { conversationQueueScope } from '../lib/dsh/conversation-scope.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getMemoryStore } from '../lib/memory/store.js';
import { getChatArchive } from '../lib/history/store.js';
import { MemoryConsolidator } from '../lib/memory/consolidation.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { runCoordinatedChat } from '../lib/dsh/orchestrator.js';

const scope = { platform: 'qq', channelId: 'group' };
const plan = source => ({
  action: 'add',
  text: source.text,
  kind: 'fact',
  sourceSeqs: [source.seq],
  evidence: source.text,
  tags: [],
  confidence: 0.9,
  importance: 0.5
});
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'memory-pipeline-'));
  const oldConfig = globalThis.__config;
  const oldFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'workspaces'),
        dshHomeRoot: join(root, 'homes'),
        modules: { settings: { memory: { automatic: false }, mood: { modelJudge: false } } }
      }
    }
  };
  const config = getDSHConfig();
  const store = getMemoryStore(config);
  const archive = getChatArchive(config);
  try {
    await run({ root, config, store, archive });
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.fetch = oldFetch;
    globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
};

test('actual model transport receives scoped sources without tools and its validated result is persisted', () =>
  fixture(async f => {
    f.archive.append(scope, { id: 'one', text: '我喜欢杭州茶馆', speakerId: 'one', speaker: '甲', role: 'user' });
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.tools, undefined);
      assert.equal(body.messages.length, 2);
      const input = JSON.parse(body.messages[1].content);
      assert.equal(input.sources.length, 1);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ changes: [plan(input.sources[0])] }) } }] });
    };
    const worker = new MemoryConsolidator(f.config);
    try {
      assert.equal((await worker.consolidate(scope, true)).added, 1);
      assert.equal(calls, 1);
      assert.equal(f.store.recall(scope, '杭州茶馆', 'one')[0].sourceRefs[0].text, '我喜欢杭州茶馆');
    } finally {
      worker.stop();
    }
  }));

test('periodic consolidation respects its interval and automatic-off leaves new archive data unprocessed', () =>
  fixture(async f => {
    f.archive.append(scope, { id: 'one', text: '我喜欢杭州茶馆', speakerId: 'one', speaker: '甲', role: 'user' });
    f.store.observe(scope);
    let calls = 0;
    const ask = async sources => {
      calls++;
      return [plan(sources[0])];
    };
    const disabled = new MemoryConsolidator(f.config, { ask });
    await disabled.tick();
    assert.equal(calls, 0);
    disabled.stop();
    const automatic = new MemoryConsolidator({ ...f.config, modules: { settings: { memory: { automatic: true } } } }, { ask });
    try {
      await automatic.tick();
      assert.equal(calls, 1);
      await automatic.tick();
      assert.equal(calls, 1);
    } finally {
      automatic.stop();
    }
  }));

test('learned facts enter a real group turn with person attribution and cannot leak a private scope', () =>
  fixture(async f => {
    // This fixture counts memory tool calls; independent opinion extraction has its own tests.
    globalThis.__config.value['alemonjs-agent-link'].modules.disabled = ['opinions'];
    const add = (target, seq, text) => {
      f.store.observe(target);
      f.store.applyExtraction(
        target,
        f.store.state(target),
        [plan({ seq, text })],
        [{ seq, text, speakerId: 'one', speaker: '甲', timestamp: Date.now() }],
        seq,
        false
      );
    };
    add(scope, 1, '我喜欢杭州茶馆');
    add({ platform: 'qq', channelId: 'private:secret' }, 2, '仅私聊可见的秘密偏好');
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls++;
      const content = JSON.stringify(body.messages);
      assert.ok(content.includes('杭州茶馆'));
      assert.ok(!content.includes('秘密偏好'));
      if (calls === 1) {
        assert.ok(content.includes('currentPerson'));
        assert.equal((content.match(/我喜欢杭州茶馆/g) || []).length, 1, 'profile facts should not be duplicated in recall context');
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'recall',
                    type: 'function',
                    function: { name: 'recall_memories', arguments: '{"query":"杭州茶馆"}' }
                  }
                ]
              }
            }
          ]
        });
      }
      const result = JSON.parse(body.messages.at(-1).content);
      assert.equal(result.items[0].about.id, 'one');
      assert.equal(result.items[0].sources[0].seq, 1);
      return Response.json({ choices: [{ message: { content: '你提到喜欢杭州茶馆。' } }] });
    };
    const output = [];
    const result = await runCoordinatedChat(
      { ChannelId: 'group', Platform: 'qq', UserId: 'one', UserKey: 'one', MessageId: 'ask' },
      '你记得我喜欢的茶馆吗',
      async event => {
        if (event.type === 'content') output.push(event.content);
      },
      undefined,
      undefined,
      undefined,
      async () => {}
    );
    await result.confirmDelivery();
    assert.deepEqual(output, ['你提到喜欢杭州茶馆。']);
    assert.equal(calls, 2);
  }));

test('memory tool falls back to same-person same-session user sources without claiming saved facts', () =>
  fixture(async f => {
    const { memoryModule } = await import('../lib/modules/memory.js');
    const tools = [];
    const disposals = [];
    memoryModule(f.config).setup({
      on() {},
      tool(tool) {
        tools.push(tool);
      },
      onDispose(fn) {
        disposals.push(fn);
      }
    });
    try {
      for (const [channelId, speakerId, text, role] of [
        ['group', 'alice', '我喜欢龙井', 'user'],
        ['group', 'bob', '别人的资料', 'user'],
        ['other', 'alice', '其他群资料', 'user'],
        ['group', 'alice', '机器人猜测', 'assistant']
      ])
        f.archive.append({ platform: 'qq', channelId }, { id: text, speakerId, speaker: speakerId, text, role });
      const result = await tools
        .find(tool => tool.name === 'recall_memories')
        .execute({ query: '以前说过什么' }, { ...scope, userId: 'alice', userText: '以前说过什么', signal: new AbortController().signal });
      assert.deepEqual(result.items, []);
      assert.deepEqual(
        result.recentSources.map(item => item.text),
        ['我喜欢龙井']
      );
    } finally {
      for (const dispose of disposals) dispose();
    }
  }));

test('archive fallback ranks older relevant evidence ahead of recent chatter and preserves scope', () =>
  fixture(async f => {
    f.archive.append(scope, { id: 'old', speakerId: 'alice', speaker: 'alice', role: 'user', text: '我喜欢龙井茶' });
    for (let i = 0; i < 40; i++) f.archive.append(scope, { id: `chat-${i}`, speakerId: 'alice', speaker: 'alice', role: 'user', text: `天气不错${i}` });
    f.archive.append(scope, { id: 'bob', speakerId: 'bob', speaker: 'bob', role: 'user', text: '龙井茶' });
    f.archive.append({ ...scope, channelId: 'other' }, { id: 'other', speakerId: 'alice', speaker: 'alice', role: 'user', text: '龙井茶' });
    const hits = f.archive.recallSources(scope, 'alice', '你记得龙井茶吗');
    assert.equal(hits[0].text, '我喜欢龙井茶');
    assert.equal(hits[0].match, 'keyword');
    assert.equal(hits.length, 1);
    assert.equal(f.archive.recallSources(scope, 'alice', '外星飞船')[0].match, 'recent');
  }));

test('explicit correction tool requires current user consent and refreshes persisted recall', () =>
  fixture(async f => {
    const { memoryModule } = await import('../lib/modules/memory.js');
    const { SessionRegistry } = await import('../lib/state/registry.js');
    const registry = new SessionRegistry(f.config);
    const channelId = 'private:alice';
    const initial = await registry.changePrivateMemory(channelId, 'add', '我住杭州', undefined, conversationQueueScope(f.config, { platform: 'qq' }));
    const args = { id: initial.notes[0].id, expectedText: '我住杭州', text: '我住苏州' };
    const tools = [];
    const disposals = [];
    memoryModule(f.config).setup({
      on() {},
      tool(tool) {
        tools.push(tool);
      },
      onDispose(fn) {
        disposals.push(fn);
      }
    });
    const tool = tools.find(tool => tool.name === 'correct_private_fact');
    const context = { platform: 'qq', channelId, userId: 'alice', private: true, userText: '更正记忆：我住苏州', signal: new AbortController().signal };
    try {
      assert.equal((await tool.execute(args, { ...context, userText: '不要更正记忆：我住苏州' })).ok, false);
      assert.equal((await tool.execute(args, { ...context, autonomous: true })).ok, false);
      assert.equal((await tool.execute({ ...args, text: '我住北京' }, context)).ok, false);
      assert.equal((await tool.execute(args, { ...context, private: false })).ok, false);
      assert.equal((await tool.execute(args, context)).ok, true);
      assert.equal((await registry.privateMemories(channelId, conversationQueueScope(f.config, context)))[0].text, '我住苏州');
      assert.equal(f.store.get(context, args.id).text, '我住苏州');
      assert.equal((await tool.execute(args, context)).status, 'stale');
    } finally {
      for (const dispose of disposals) dispose();
    }
  }));

test('memory diagnostics report automatic-off without invoking a model or changing the checkpoint', () =>
  fixture(async f => {
    const { memoryModule } = await import('../lib/modules/memory.js');
    const tools = [];
    const disposals = [];
    memoryModule(f.config).setup({
      on() {},
      tool(tool) {
        tools.push(tool);
      },
      onDispose(fn) {
        disposals.push(fn);
      }
    });
    try {
      f.archive.append(scope, { id: 'pending', text: '我喜欢茶叶', speakerId: 'one', speaker: 'one', role: 'user' });
      const tool = tools.find(tool => tool.name === 'inspect_memory_status');
      assert.equal(tool.readOnly, true);
      const result = await tool.execute({}, { ...scope, userId: 'one' });
      assert.equal(result.reason, 'automatic-disabled');
      assert.equal(result.checkpoint, 0);
      assert.ok(result.latestArchiveSeq > 0);
      assert.equal(result.nextEligibleAt, null);
    } finally {
      for (const dispose of disposals) dispose();
    }
  }));

test('forget suppresses historical fallback but permits new statements and other people', () =>
  fixture(async f => {
    const { memoryModule } = await import('../lib/modules/memory.js');
    f.store.syncExplicit(scope, 'alice', [{ id: '12345678', text: '我喜欢龙井茶', createdAt: Date.now() }]);
    for (const who of ['alice', 'bob']) f.archive.append(scope, { id: who, speakerId: who, speaker: who, text: '我喜欢龙井茶', role: 'user' });
    f.store.forget(scope, '12345678', f.archive.latestSeq(scope));
    const tools = [];
    const disposals = [];
    memoryModule(f.config).setup({
      on() {},
      tool(tool) {
        tools.push(tool);
      },
      onDispose(fn) {
        disposals.push(fn);
      }
    });
    const recall = tools.find(tool => tool.name === 'recall_memories');
    const context = { ...scope, userId: 'alice', userText: '你记得龙井茶吗', signal: new AbortController().signal };
    try {
      assert.deepEqual((await recall.execute({}, context)).recentSources, []);
      assert.equal((await recall.execute({ subjectId: 'bob' }, context)).recentSources.length, 1);
      f.archive.append(scope, { id: 'new', speakerId: 'alice', speaker: 'alice', text: '我现在喜欢红茶', role: 'user' });
      assert.deepEqual(
        (await recall.execute({}, context)).recentSources.map(item => item.text),
        ['我现在喜欢红茶']
      );
      f.store.clear(scope, f.archive.latestSeq(scope));
      assert.deepEqual((await recall.execute({ subjectId: 'bob' }, context)).recentSources, []);
    } finally {
      for (const dispose of disposals) dispose();
    }
  }));
