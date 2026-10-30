import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultCode, withEventContext, getConfig, markdownToPlainText } from 'alemonjs';
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
const runCommand = async (module, { private: isPrivate = true, master = true, key = '帮助', args = [], formats = [], failAt = 0, next = () => {} } = {}) => {
  const messages = [];
  const event = {
    name: isPrivate ? 'private.message.create' : 'message.create',
    IsPrivate: isPrivate,
    IsMaster: master,
    Platform: 'qq-bot',
    BotId: '900',
    UserId: '100',
    UserKey: 'user-100',
    ChannelId: isPrivate ? undefined : '200',
    MessageId: 'fixture',
    MessageText: `/${key} ${args.join(' ')}`,
    __route: { key, text: key, rawArgs: args, parsedArgs: [], params: {} }
  };
  await runtimeScope.run(
    {
      resources: new Map(),
      cleanups: new Set(),
      disposed: false,
      now: Date.now,
      action: async frame => {
        const format = frame.payload.params?.format || [];
        formats.push(format);
        messages.push(
          format.map(item => (item.type === 'Markdown' ? markdownToPlainText(item.value) : typeof item.value === 'string' ? item.value : '')).join('')
        );
        return [{ code: messages.length === failAt ? ResultCode.Fail : ResultCode.Ok, data: { id: 'fixture', messageId: 'fixture' } }];
      }
    },
    () => {
      getConfig().saveValue(globalThis.__config?.value || {});
      return withEventContext(event, next, module, { appName: 'alemonjs-agent-link' });
    }
  );
  return messages;
};

test('advertisement list responds in both group and private chats and is silent when disabled', async () => {
  const handler = (await import('../lib/response/agent-ads/res.js')).default;
  const previous = globalThis.__config;
  try {
    for (const enabled of [true, false]) {
      globalThis.__config = {
        value: {
          'alemonjs-agent-link': {
            budget: { enabled: true },
            ads: { enabled, items: [{ id: 'demo', title: '测试广告', content: '内容', rewardYuan: 0.01, enabled: true }] }
          }
        }
      };
      for (const isPrivate of [true, false]) {
        const result = await runCommand(handler, { private: isPrivate, key: '广告列表' });
        assert.equal(result.length, enabled ? 1 : 0);
        if (enabled) assert.match(result[0], /测试广告/);
      }
    }
  } finally {
    globalThis.__config = previous;
  }
});


test('long ad detail stops on failed delivery before attempting any reward', async () => {
  const handler = (await import('../lib/response/agent-ads/res.js')).default;
  const previous = globalThis.__config;
  const formats = [];
  globalThis.__config = { value: { 'alemonjs-agent-link': { maxMessageLength: 300, budget: { enabled: true }, ads: { enabled: true, items: [{ id: 'long', title: '长广告', content: '完整内容🐟'.repeat(180), url: 'https://example.com/ad', rewardYuan: 0.01, enabled: true }] } } } };
  try {
    await assert.rejects(runCommand(handler, { key: '广告详情', args: ['long'], formats, failAt: 2 }), /成功回执/);
    assert.equal(formats.length, 2);
    assert.doesNotMatch(JSON.stringify(formats), /已获得|奖励暂未确认|广告列表|BT.group/);
  } finally { globalThis.__config = previous; }
});
