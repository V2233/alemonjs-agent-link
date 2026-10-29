import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResultCode } from 'alemonjs';
import { GroupWaitController } from '../lib/social/group-wait.js';
import { conversationModule } from '../lib/modules/conversation.js';
import { GroupConversationCoordinator } from '../lib/social/group-conversation.js';
import { getGroupChatPolicy } from '../lib/social/group-policy.js';
import { respondToGroupBatch } from '../lib/social/respond.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { messageReferences } from '../lib/social/references.js';
const message = (id, userId, text = '普通消息', direct = false) => ({
  id,
  platform: 'qq',
  channelId: 'wait-group',
  userId,
  userKey: userId,
  name: userId,
  owner: false,
  text,
  direct,
  addressed: direct
});
const policy = overrides => getGroupChatPolicy({ activity: 'active', quietHours: [0, 0], interjectChance: 1, cooldownSeconds: 0, interests: [], ...overrides });
const verdict = { reply: true, addressed: 'none', related: 'my_thread', reason: 'context', source: 'human', loopRisk: false };

test('waits require known speakers and bounded conditions, normalize literal keywords, and expire without sending', () => {
  const waits = new GroupWaitController();
  const ticket = waits.begin('qq', 'alice');
  for (const request of [{ seconds: 1 }, { seconds: 301 }, { speakerId: 'unknown' }, { keyword: 'a\nb' }, { keyword: 'x'.repeat(41) }])
    assert.equal(waits.apply(ticket, { action: 'wait', ...request }, ['alice', 'bob'], 'alice', 0).ok, false);
  assert.equal(waits.apply(ticket, { action: 'wait', speakerId: 'bob', keyword: 'ＡＢＣ', seconds: 15 }, ['alice', 'bob'], 'alice', 0).state, 'waiting');
  assert.equal(waits.observe(message('a', 'alice', 'ABC'), 1), 'waiting');
  assert.equal(waits.observe({ ...message('b', 'bob', 'abc'), platform: 'onebot' }, 1), 'idle');
  assert.equal(waits.observe(message('c', 'bob', '其它内容'), 2), 'waiting');
  assert.equal(waits.observe(message('d', 'bob', '找到了abc'), 3), 'matched');
  assert.equal(waits.observe(message('e', 'bob', 'abc'), 4), 'idle');
  assert.equal(waits.apply(ticket, { action: 'wait' }, ['alice'], 'alice', 5).ok, false);
  const next = waits.begin('qq', 'alice');
  waits.apply(next, { action: 'wait', seconds: 15 }, ['alice'], 'alice', 10);
  assert.equal(waits.observe(message('f', 'alice'), 15010), 'idle');
});

test('explicit calls, cancellation and invalidation prevent late wait setup', () => {
  const waits = new GroupWaitController();
  for (const action of ['direct', 'cancel', 'clear']) {
    const ticket = waits.begin('qq', 'alice');
    waits.apply(ticket, { action: 'wait' }, ['alice'], 'alice', 0);
    if (action === 'direct') assert.equal(waits.observe(message('wake', 'bob', '肥鱼', true), 1), 'idle');
    else if (action === 'cancel') assert.equal(waits.apply(ticket, { action: 'cancel' }, ['alice'], 'alice', 1).state, 'idle');
    else waits.clear('alice');
    if (action !== 'cancel') assert.equal(waits.apply(ticket, { action: 'wait' }, ['alice'], 'alice', 2).ok, false);
  }
});

test('waiting tool is unavailable without a current group callback and propagates cancellation', async () => {
  let tool;
  conversationModule().setup({
    tool: value => {
      tool = value;
    }
  });
  const context = {
    platform: 'qq',
    channelId: 'group',
    private: false,
    autonomous: false,
    signal: new AbortController().signal,
    onGroupWait: request => ({ ok: true, state: request.action === 'wait' ? 'waiting' : 'idle' })
  };
  assert.equal(tool.available(context), true);
  for (const patch of [{ private: true }, { autonomous: true }, { onGroupWait: undefined }, { platform: '' }])
    assert.equal(tool.available({ ...context, ...patch }), false);
  assert.equal((await tool.execute({ action: 'wait' }, context)).state, 'waiting');
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(tool.execute({ action: 'wait' }, { ...context, signal: controller.signal }), /cancelled/);
});

test('coordinator suppresses unrelated messages without classifier calls and wakes through ordinary policy', async () => {
  let now = Date.parse('2026-10-29T04:00:00Z');
  let classifications = 0;
  let responses = 0;
  let setWait;
  const coordinator = new GroupConversationCoordinator({
    now: () => now,
    random: () => 0,
    schedule: () => 1,
    unschedule: () => {},
    classify: async input => {
      classifications++;
      assert.equal(input.messages.at(-1).waitMatched, true);
      return verdict;
    }
  });
  const p = policy();
  const respond = async batch => {
    responses++;
    if (responses === 1) {
      setWait = batch.onGroupWait;
      assert.equal(setWait({ action: 'wait', keyword: '找到了', seconds: 30 }).state, 'waiting');
    }
    return { delivered: true, replyText: '你找好资料再说。' };
  };
  try {
    const first = coordinator.receive(message('start', 'alice', '肥鱼', true), p, respond);
    await coordinator.flush('wait-group');
    await first;
    assert.equal((await coordinator.receive(message('other', 'bob'), p, respond)).reply, false);
    assert.equal((await coordinator.receive(message('not-yet', 'alice', '我再看看'), p, respond)).reply, false);
    assert.equal(classifications, 0);
    assert.equal(responses, 1);
    const found = coordinator.receive(message('found', 'alice', '找到了'), p, respond);
    await coordinator.flush('wait-group');
    await found;
    assert.equal(responses, 2);
    assert.equal(classifications, 1);
    assert.equal(setWait({ action: 'wait' }).ok, false);
    now += 40000;
  } finally {
    coordinator.close();
  }
});

test('waiting matches do not bypass quiet hours or a disabled participation policy', async () => {
  for (const overrides of [{ enabled: false }, { quietHours: [0, 23] }]) {
    const coordinator = new GroupConversationCoordinator({
      now: () => Date.parse('2026-10-29T04:00:00Z'),
      schedule: () => 1,
      unschedule: () => {},
      classify: async () => verdict
    });
    let count = 0;
    const respond = async batch => {
      count++;
      batch.onGroupWait({ action: 'wait' });
      return { delivered: true, replyText: '等你。' };
    };
    try {
      const first = coordinator.receive(message('first', 'alice', '肥鱼', true), policy(overrides), respond);
      await coordinator.flush('wait-group');
      await first;
      const matched = await coordinator.receive(message('match', 'alice', '找到了'), policy(overrides), respond);
      assert.equal(matched.reply, false);
      assert.equal(count, 1);
    } finally {
      coordinator.close();
    }
  }
});

test('a real module turn sets a group wait and a matching new message reaches the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-wait-turn-'));
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
        modules: { disabled: ['opinions', 'proactive', 'mood'] }
      }
    }
  };
  const config = getDSHConfig();
  let modelCalls = 0;
  const sends = [];
  const coordinator = new GroupConversationCoordinator({ schedule: () => 1, unschedule: () => {}, classify: async () => verdict });
  const transport = {
    message: {
      send: async params => {
        sends.push(params);
        return [{ code: ResultCode.Ok, data: { id: `out-${sends.length}` } }];
      }
    },
    media: { send: async () => assert.fail('no media expected') }
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    modelCalls++;
    assert.ok(body.tools.some(tool => tool.function.name === 'set_group_wait'));
    if (modelCalls === 1)
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'wait',
                  type: 'function',
                  function: { name: 'set_group_wait', arguments: JSON.stringify({ action: 'wait', keyword: '找到了', seconds: 60 }) }
                }
              ]
            }
          }
        ]
      });
    if (modelCalls === 2) {
      const result = JSON.parse(body.messages.find(item => item.role === 'tool').content);
      assert.equal(result.state, 'waiting');
      assert.equal(result.speakerId, 'alice');
      return Response.json({ choices: [{ message: { content: '行，你找好再说。' } }] });
    }
    assert.equal(modelCalls, 3);
    assert.match(JSON.stringify(body.messages), /命中了你此前设置的等待条件/);
    return Response.json({ choices: [{ message: { content: '发来看看。' } }] });
  };
  const respond = batch =>
    respondToGroupBatch(
      {
        Platform: 'qq',
        BotId: 'bot',
        ChannelId: 'wait-group',
        UserId: batch.anchor.userId,
        UserKey: batch.anchor.userKey,
        MessageId: batch.anchor.id,
        IsPrivate: false
      },
      transport,
      batch
    );
  try {
    const first = coordinator.receive(message('model-first', 'alice', '肥鱼，等我找一下资料', true), policy(), respond);
    await coordinator.flush('wait-group');
    await first;
    assert.equal(modelCalls, 2);
    assert.equal(sends.length, 1);
    await coordinator.receive(message('model-unrelated', 'bob', '别的事情'), policy(), respond);
    assert.equal(modelCalls, 2);
    const found = coordinator.receive(message('model-found', 'alice', '找到了'), policy(), respond);
    await coordinator.flush('wait-group');
    await found;
    assert.equal(modelCalls, 3);
    assert.equal(sends.length, 2);
  } finally {
    coordinator.close();
    await messageReferences.clear('wait-group');
    await (await getModuleRuntime(config)).close();
    globalThis.__config = previous.config;
    globalThis.fetch = previous.fetch;
    await rm(root, { recursive: true, force: true });
  }
});
