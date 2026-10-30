import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultCode, getConfig } from 'alemonjs';
import { normalizeOneBotEvent } from '../lib/onebot/events.js';
import { OneBotActions } from '../lib/onebot/actions.js';
import { readCurrentForwards } from '../lib/social/onebot-forward.js';
import { respondToGroupBatch } from '../lib/social/respond.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('forwarded records are read through the adapter, bounded, attributed and treated as data', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const event = normalizeOneBotEvent(
    { post_type: 'message', message_type: 'private', self_id: 900, user_id: 100, message_id: 50, message: [{ type: 'forward', data: { id: 'forward_1' } }] },
    '900',
    () => true
  );
  assert.equal(event.MessageText, '[合并转发]');
  const calls = [];
  const adapter = new OneBotActions(
    {
      config: { selfId: '900' },
      call: async (action, args) => {
        calls.push({ action, args });
        return {
          messages: [
            {
              sender: { nickname: '阿明' },
              message: [
                { type: 'text', data: { text: '你好 sk-abcdefgh1234' } },
                { type: 'image', data: { url: 'https://ignored.invalid/pic' } },
                { type: 'forward', data: { id: 'nested' } }
              ]
            },
            ...Array.from({ length: 30 }, () => ({ sender: { nickname: '其他' }, message: [{ type: 'text', data: { text: '长'.repeat(1200) } }] }))
          ]
        };
      }
    },
    () => ({ owner: () => true, groups: [], disabled: [] })
  );
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  await runtimeScope.run(runtime, async () => {
    const rows = JSON.parse(await readCurrentForwards(event));
    assert.equal(rows[0].sender, '阿明');
    assert.match(rows[0].text, /个人密钥管理消息已隐藏/);
    assert.doesNotMatch(rows[0].text, /sk-/);
    assert.deepEqual(rows[0].attachments, ['image', 'forward']);
    assert.ok(rows.length <= 24);
    assert.ok(rows.reduce((sum, row) => sum + row.text.length, 0) <= 6000);
    assert.deepEqual(calls, [{ action: 'get_forward_msg', args: { id: 'forward_1' } }]);
  });
  const invalid = await adapter.api({ payload: { event, key: 'agentLink.readCurrentForward', params: [{ id: 'other' }] } });
  assert.notEqual(invalid[0].code, ResultCode.Ok);
  assert.equal(calls.length, 1);
});

test('unsupported extension reports missing content', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const adapter = new OneBotActions(
    {
      config: { selfId: '900' },
      call: async () => {
        throw new Error('unsupported');
      }
    },
    () => ({ owner: () => true, groups: [], disabled: [] })
  );
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  await runtimeScope.run(runtime, async () => {
    const result = await readCurrentForwards({ Platform: 'onebot', BotId: '900', UserId: '100', IsPrivate: true, _ForwardIds: ['abc'] });
    assert.deepEqual(JSON.parse(result), [{ id: 'abc', unavailable: true }]);
  });
});

test('group batch puts each forwarded message into the actual model request', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'forward-batch-'));
  const oldConfig = globalThis.__config;
  const oldFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        modules: { disabled: ['opinions'], settings: { mood: { modelJudge: false }, expression: { automatic: false } } }
      }
    }
  };
  const config = getDSHConfig();
  const calls = [];
  const adapter = new OneBotActions(
    {
      config: { selfId: '900' },
      call: async (action, args) => {
        assert.equal(action, 'get_forward_msg');
        calls.push(args.id);
        return { messages: [{ sender: { nickname: `作者${args.id}` }, message: [{ type: 'text', data: { text: `正文${args.id}` } }] }] };
      }
    },
    () => ({ owner: () => true, groups: [], disabled: [] })
  );
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  const groupEvent = { Platform: 'onebot', BotId: '900', IsPrivate: false, ChannelId: '200', UserId: '100', MessageId: '1' };
  const first = {
    channelId: '200',
    platform: 'onebot',
    id: '1',
    userId: '100',
    userKey: '100',
    name: '甲',
    owner: true,
    text: '[合并转发]',
    direct: true,
    forwardIds: ['f1']
  };
  const second = { ...first, id: '2', userId: '101', userKey: '101', name: '乙', forwardIds: ['f2'] };
  let modelCalls = 0;
  globalThis.fetch = async (_url, init) => {
    modelCalls++;
    const content = JSON.stringify(JSON.parse(init.body).messages);
    assert.match(content, /正文f1/);
    assert.match(content, /正文f2/);
    return Response.json({ choices: [{ message: { content: '看到了。' } }] });
  };
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue(globalThis.__config.value);
      const result = await respondToGroupBatch(
        groupEvent,
        { message: { send: async () => [{ code: ResultCode.Ok, data: { id: '99' } }] }, media: { send: async () => assert.fail('unexpected media') } },
        { id: 'batch', mode: 'direct', messages: [first, second], anchor: first }
      );
      assert.equal(result.delivered, true);
      assert.deepEqual(calls.sort(), ['f1', 'f2']);
      assert.equal(modelCalls, 1);
    });
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.fetch = oldFetch;
    globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
});
