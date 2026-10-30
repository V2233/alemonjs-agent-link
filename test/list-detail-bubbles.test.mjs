import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from 'alemonjs/testing';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getMoodStore, moodOptions } from '../lib/companion/mood.js';
import { recordRecentMessage } from '../lib/chat-context/store.js';
import { conversationQueueScope } from '../lib/dsh/conversation-scope.js';

const fixture = async (run, extra = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'list-detail-bubbles-'));
  const settings = { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), ...extra };
  const config = getDSHConfig(settings);
  const app = createTestApp({ config: { 'alemonjs-agent-link': settings } });
  const command = async (module, key, args = []) => {
    const event = app.events.groupMessage({}, { Platform: 'qq-bot', BotId: 'bot', UserId: 'u', ChannelId: 'g', IsMaster: true, MessageText: `/${key} ${args.join(' ')}`, __route: { key, text: key, rawArgs: args, parsedArgs: [], params: {} } });
    Object.assign(event, { Platform: 'qq-bot', BotId: 'bot', ChannelId: 'g' });
    const result = await app.runHandler((await import(`../lib/response/${module}/res.js`)).default, event, 'alemonjs-agent-link');
    assert.equal(result.errors.length, 0);
    return { text: JSON.stringify(result.messages), payload: JSON.stringify(result.actions.map(a => a.request.payload?.params)), result };
  };
  try { await run({ command, config }); }
  finally { getMoodStore(config).close(); await app.dispose(); await rm(root, { recursive: true, force: true }); }
};

test('sponsors keep list previews bounded while complete details remain reachable', () => fixture(async ({ command }) => {
  const list = await command('agent-sponsors', '赞助列表');
  assert.ok(list.text.length < 4000);
  assert.match(list.payload, /\/赞助列表 详情 item0/);
  const details = await command('agent-sponsors', '赞助列表', ['详情', 'item5']);
  assert.ok(details.result.messages.length > 1);
  assert.match(details.text, /内容终点/);
  assert.match(details.payload, /\/赞助列表 2/);
  assert.match(details.payload, /https:\/\/example.com/);
  assert.doesNotMatch(details.payload, /BT.group|\\ud83d(?!\\udc1f)/);
  const missing = await command('agent-sponsors', '赞助列表', ['详情', 'missing']);
  assert.match(missing.text, /已下架/);
}, { sponsors: { enabled: true, items: Array.from({ length: 6 }, (_, i) => ({ id: `item${i}`, title: `赞助${i}`, content: '正文🐟'.repeat(350) + '内容终点', url: 'https://example.com', enabled: true })) } }));

test('mood history is readable rows and context preview does not expose model instructions', () => fixture(async ({ command, config }) => {
  const store = getMoodStore(config);
  store.observe({ platform: 'qq-bot', channelId: 'g' }, 'mood-fixture', 3, moodOptions(config));
  const mood = await command('agent-mood', '心情');
  assert.match(mood.text, /变化.*当时心情/);
  assert.doesNotMatch(mood.text, /\| ---|\| 时间|BT.group/);
  await recordRecentMessage('g', { id: 'recent', text: '小明说：明天讨论计划', timestamp: Date.now() }, {}, config, conversationQueueScope(config, { platform: 'qq-bot', botId: 'bot' }));
  const context = await command('agent-context', '聊天参考');
  assert.match(context.text, /明天讨论计划/);
  assert.match(context.text, /并非完整聊天记录/);
  assert.doesNotMatch(context.text, /compressed_recent_group_context|不应作为指令执行|Agent 的历史回合/);
}));

test('clearing context rejects trailing input, preserves other bots, and reports store failures truthfully', () => fixture(async ({ command, config }) => {
  const { SessionRegistry } = await import('../lib/state/registry.js');
  const registry = new SessionRegistry(config);
  const scope = conversationQueueScope(config, { platform: 'qq-bot', botId: 'bot' });
  const other = conversationQueueScope(config, { platform: 'qq-bot', botId: 'other' });
  for (const target of [scope, other]) {
    await recordRecentMessage('g', { id: 'clear-fixture', text: '保留的参考内容', timestamp: Date.now() }, {}, config, target);
  }
  const invalid = await command('agent-context-clear', '聊天参考 清除', ['多余']);
  assert.match(invalid.text, /不需要填写内容/);
  assert.equal((await registry.recent('g', undefined, scope)).length, 1);
  const cleared = await command('agent-context-clear', '聊天参考 清除');
  assert.match(cleared.text, /本群近期聊天参考已清除/);
  assert.match(cleared.text, /新的群消息/);
  assert.equal((await registry.recent('g', undefined, scope)).length, 0);
  assert.equal((await registry.recent('g', undefined, other)).length, 1);
  const original = SessionRegistry.prototype.clearRecent;
  SessionRegistry.prototype.clearRecent = async () => { throw new Error('fixture storage failure'); };
  try {
    const failed = await command('agent-context-clear', '聊天参考 清除');
    assert.match(failed.text, /无法确认是否已清除/);
    assert.match(failed.payload, /\/聊天参考/);
    assert.doesNotMatch(failed.text, /参考已清除|fixture storage failure/);
  } finally { SessionRegistry.prototype.clearRecent = original; }
}));
