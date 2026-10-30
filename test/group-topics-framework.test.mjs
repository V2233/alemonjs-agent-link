import settingsHandler from '../lib/response/agent-group-settings/res.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from 'alemonjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../lib/response/history-capture/res.js';
import { getGroupTopicStore, groupTopicId } from '../lib/group-topics/store.js';

test('real history handler observes ordinary group messages without consuming the plugin chain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'topic-framework-'));
  const config = {
    workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'),
    stateBackend: 'local',
    modules: { settings: { proactive: { autoSubscribe: false } } }
  };
  const app = createTestApp({ config: { 'alemonjs-agent-link': config } });
  const store = getGroupTopicStore(config);
  try {
    const event = app.events.groupMessage(
      {},
      {
        Platform: 'qq-bot',
        BotId: 'bot',
        ChannelId: 'group',
        UserId: 'human',
        MessageId: 'topic-message',
        MessageText: '修仙新版本的材料消耗值得讨论',
        IsBot: false,
        IsPrivate: false
      }
    );
    const result = await app.runHandler(handler, event, 'alemonjs-agent-link');
    assert.equal(result.errors.length, 0);
    assert.equal(result.nextCalls.length, 1);
    assert.equal(result.messages.length, 0);
    const id = groupTopicId('qq-bot', 'bot', 'group');
    assert.equal(store.profile(id)?.enabled, true);
    assert.equal(store.pending(id).length, 1);
    await app.runHandler(handler, event, 'alemonjs-agent-link');
    assert.equal(store.pending(id).length, 1);
    const bot = app.events.groupMessage(
      {},
      { Platform: 'qq-bot', BotId: 'bot', ChannelId: 'other', UserId: 'bot', IsBot: true, MessageId: 'bot-message', MessageText: '机器人分享' }
    );
    const ignored = await app.runHandler(handler, bot, 'alemonjs-agent-link');
    assert.equal(ignored.nextCalls.length, 1);
    assert.equal(store.profiles().length, 1);
    const manage = async args => {
      const event = app.events.groupMessage(
        {},
        {
          Platform: 'qq-bot',
          BotId: 'bot',
          ChannelId: 'group',
          UserId: 'admin',
          IsMaster: true,
          MessageId: `manage-${args.join('-')}`,
          MessageText: `/群设置 ${args.join(' ')}`,
          __route: { key: '群设置', text: '群设置', rawArgs: args, parsedArgs: [], params: {} }
        }
      );
      return app.runHandler(settingsHandler, event, 'alemonjs-agent-link');
    };
    const corrected = await manage(['话题', '定位', '管理员纠正后的游戏群']);
    assert.equal(corrected.errors.length, 0);
    assert.equal(store.profile(id).positioning, '管理员纠正后的游戏群');
    assert.match(JSON.stringify(corrected.messages), /管理员纠正后的游戏群/);
    const disabled = await manage(['话题', '冒泡', '关闭']);
    assert.equal(disabled.errors.length, 0);
    assert.equal(store.profile(id).enabled, false);
    await app.runHandler(
      handler,
      app.events.groupMessage({}, { Platform: 'qq-bot', BotId: 'bot', ChannelId: 'group', UserId: 'human', MessageId: 'after-off', MessageText: '还有更新' }),
      'alemonjs-agent-link'
    );
    assert.equal(store.pending(id).length, 1);
  } finally {
    await app.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
