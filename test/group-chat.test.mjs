import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultCode } from 'alemonjs';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { groupConversations } from '../lib/social/groups.js';
import { respondToGroupBatch, submitGroupChat } from '../lib/social/respond.js';
import { messageReferences } from '../lib/social/references.js';

test('group batch reaches the actual model once, quotes a selected participant and saves rendered history', async () => {
  // Production keeps the bot process alive; the coordinator deliberately unrefs its timers.
  const keepAlive = setInterval(() => {}, 1000);
  const root = await mkdtemp(join(tmpdir(), 'group-chat-'));
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
        groupChat: { interjectChance: 0, batchWindowMs: 5000, maxBatchWaitMs: 5000 }
      }
    }
  };
  const config = getDSHConfig();
  const registry = new SessionRegistry(config);
  const sends = [];
  let modelCalls = 0;
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
    modelCalls++;
    const body = JSON.parse(init.body);
    const text = body.messages.at(-1).content;
    if (modelCalls === 1) {
      assert.ok(text.includes('alpha'));
      assert.ok(text.includes('beta'));
    } else {
      assert.ok(text.includes('charlie'));
      assert.ok(text.includes('"owner":false'));
    }
    return Response.json({ choices: [{ message: { content: modelCalls === 1 ? '<reply:m1>收到两位的问题了。' : '<reply:m1>新问题已收到。' } }] });
  };
  const incoming = (id, name) => ({
    Platform: 'qq',
    BotId: 'bot',
    ChannelId: 'group',
    MessageId: id,
    UserId: name,
    UserKey: name,
    UserName: name,
    IsPrivate: false
  });
  try {
    const a = incoming('a', 'alpha');
    const b = { ...incoming('b', 'beta'), IsMaster: true };
    const one = submitGroupChat(a, '一起聊游戏', transport);
    const two = submitGroupChat(b, '一起聊游戏', transport);
    await groupConversations.flush('group');
    await Promise.all([one, two]);
    assert.equal(modelCalls, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].replyId, 'a');
    const meta = await registry.meta('group');
    const history = await registry.privateHistory({ channelId: 'group', generation: meta.generation });
    assert.equal(history.at(-1).content, '收到两位的问题了。');
    const quote = await messageReferences.capture({ ...b, MessageId: 'quote', ReplyId: 'out-1' });
    assert.equal(quote.quote.isBot, true);
    groupConversations.clear('group');
    const replay = submitGroupChat(a, '重复投递第一条消息', transport);
    await groupConversations.flush('group');
    await replay;
    assert.equal(modelCalls, 1);
    assert.equal(sends.length, 1);
    const c = incoming('c', 'charlie');
    const fresh = submitGroupChat(c, '一个新问题', transport);
    const oldOwner = submitGroupChat(b, '重复投递已回答的主人消息', transport);
    await groupConversations.flush('group');
    await Promise.all([fresh, oldOwner]);
    assert.equal(modelCalls, 2);
    assert.equal(sends.length, 2);
    assert.equal(sends[1].replyId, 'c');
  } finally {
    clearInterval(keepAlive);
    groupConversations.clear('group');
    await messageReferences.clear('group');
    await (await getModuleRuntime(config)).close();
    globalThis.fetch = oldFetch;
    globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test('optional silence is completed without platform output while failed delivery remains unsuccessful', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-silence-'));
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
        dshHomeRoot: join(root, 'homes')
      }
    }
  };
  const config = getDSHConfig();
  let answer = '[沉默]';
  let sends = 0;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: answer } }] });
  const transport = {
    message: {
      send: async () => {
        sends++;
        return [{ code: ResultCode.Fail, data: null }];
      }
    },
    media: { send: async () => assert.fail('no media expected') }
  };
  const event = { Platform: 'qq', ChannelId: 'silent', MessageId: 'a', UserId: 'one', UserKey: 'one' };
  const anchor = { channelId: 'silent', id: 'a', userId: 'one', userKey: 'one', name: 'one', text: '聊游戏', owner: false, direct: false };
  try {
    const silent = await respondToGroupBatch(event, transport, { id: 'silent-batch', mode: 'interject', anchor, messages: [anchor] });
    assert.equal(silent.delivered, false);
    assert.equal(silent.completed, true);
    assert.equal(sends, 0);
    answer = '有个想法。';
    const failedAnchor = { ...anchor, id: 'b' };
    const failed = await respondToGroupBatch({ ...event, MessageId: 'b' }, transport, {
      id: 'failed-batch',
      mode: 'interject',
      anchor: failedAnchor,
      messages: [failedAnchor]
    });
    assert.equal(failed.delivered, false);
    assert.equal(failed.completed, false);
    const registry = new SessionRegistry(config);
    const meta = await registry.meta('silent');
    assert.deepEqual(await registry.privateHistory({ channelId: 'silent', generation: meta.generation }), []);
  } finally {
    await (await getModuleRuntime(config)).close();
    await messageReferences.clear('silent');
    globalThis.fetch = oldFetch;
    globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
});
