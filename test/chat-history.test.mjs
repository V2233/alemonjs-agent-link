import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatArchive, getChatArchive } from '../lib/history/store.js';
import { archiveIncoming } from '../lib/history/capture.js';
import { chatHistoryModule } from '../lib/modules/chat-history.js';
import { executeTool } from '../lib/agent/modules.js';

const scope = { platform: 'qq', channelId: 'group-a' };
const msg = (id, text, extra = {}) => ({ id, text, speakerId: 'u1', speaker: '小明', role: 'user', ...extra });

test('archive survives reopening, deduplicates and isolates platform/conversation/context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-history-'));
  let archive;
  try {
    const path = join(root, 'archive.sqlite');
    archive = new ChatArchive(path);
    archive.append(scope, msg('1', '昨天讨论配置'));
    archive.append(scope, msg('1', 'duplicate'));
    archive.append(scope, msg('2', '配置已经改好'));
    archive.append({ ...scope, channelId: 'private:other' }, msg('3', '私聊秘密'));
    archive.append({ ...scope, platform: 'other' }, msg('4', '另一平台秘密'));
    archive.close();
    archive = new ChatArchive(path);
    const page = archive.search(scope, { keyword: '配置', limit: 1 });
    assert.equal(page.items[0].text, '配置已经改好');
    assert.ok(page.nextCursor);
    assert.equal(archive.search(scope, { keyword: '配置', before: page.nextCursor }).items[0].text, '昨天讨论配置');
    assert.equal(archive.search(scope).items.length, 2);
    assert.equal(archive.context(scope, page.items[0].seq).items.length, 2);
    const secret = archive.search({ ...scope, channelId: 'private:other' }).items[0];
    assert.equal(archive.context(scope, secret.seq).items.length, 0);
    assert.equal(archive.search(scope, { keyword: "' OR 1=1 --" }).items.length, 0);
    assert.equal(archive.search(scope, { speakerId: 'u2' }).items.length, 0);
    archive.purge(scope);
    assert.equal(archive.search(scope).items.length, 0);
    assert.equal(archive.search({ ...scope, channelId: 'private:other' }).items.length, 1);
  } finally {
    archive?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retention, time filters and response size stay bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-history-'));
  const archive = new ChatArchive(join(root, 'a.sqlite'));
  try {
    archive.append(scope, msg('old', 'expired', { timestamp: Date.now() - 31 * 86400000 }));
    for (let i = 0; i < 30; i++) {
      archive.append(scope, msg(String(i), '字'.repeat(9000)));
    }
    assert.equal(archive.search(scope, { keyword: 'expired' }).items.length, 0);
    assert.equal(archive.search(scope, { to: Date.now() - 100000 }).items.length, 0);
    const page = archive.search(scope, { limit: 100 });
    assert.equal(page.items.length, 20);
    assert.ok(page.items.every(row => row.text.length === 300 && row.truncated));
    archive.cleanup();
  } finally {
    archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('capture excludes auth secrets, limits private access, and tools cannot choose another scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-history-tool-'));
  const config = { dshHomeRoot: join(root, 'homes'), retentionDays: 30, privateChatAccess: 'owner' };
  const archive = getChatArchive(config);
  try {
    const event = { Platform: 'qq', ChannelId: 'group-a', MessageId: '1', UserId: 'u1', MessageText: '配置讨论' };
    archiveIncoming(config, event);
    archiveIncoming(config, event);
    archiveIncoming(config, { ...event, MessageId: '2', MessageText: '/我的主人 123456' });
    archiveIncoming(config, { ...event, MessageId: 'secret-alias', MessageText: '/我是主人 123456' });
    archiveIncoming(config, { ...event, MessageId: '3', IsPrivate: true });
    archiveIncoming(config, { ...event, MessageId: '4', IsBot: true });
    archiveIncoming(config, { ...event, MessageId: '5', MessageText: '', MessageMedia: [{ Type: 'image', Url: 'secret-url' }] });
    assert.equal(archive.search(scope).items.length, 2);
    assert.equal(archive.search(scope).items[0].text, '[附件:image]');
    const tools = [];
    await chatHistoryModule(config).setup({ tool: tool => tools.push(tool), on() {} });
    const context = { ...scope, userId: 'u1', private: false, signal: new AbortController().signal };
    const result = await executeTool(tools[0], { keyword: '配置' }, context);
    assert.equal(result.items.length, 1);
    await assert.rejects(executeTool(tools[0], { channelId: 'other' }, context));
    await assert.rejects(executeTool(tools[0], { from: 'yesterday' }, context));
  } finally {
    archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('real chat delivery archives successful output and omits rejected delivery', async () => {
  const { runDSHChat } = await import('../lib/response/dsh/chat.js');
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const { getModuleRuntime } = await import('../lib/agent/modules.js');
  const { ResultCode } = await import('alemonjs');
  const root = await mkdtemp(join(tmpdir(), 'archive-delivery-'));
  const originalConfig = globalThis.__config;
  const originalFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home')
      }
    }
  };
  const config = getDSHConfig();
  let success = true;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: success ? '已成功发送的回答' : '不应归档的回答' } }] });
  const transport = {
    message: {
      send: async () => [{ code: success ? ResultCode.Ok : ResultCode.Fail, data: success ? { id: 'delivered-1', referenceId: 'delivered-ref' } : null }]
    },
    media: { send: async () => assert.fail('unexpected audio') }
  };
  const event = { Platform: 'qq', ChannelId: 'group-a', UserId: 'u1', MessageId: 'first' };
  try {
    await runDSHChat(event, '你好', { transport });
    const archive = getChatArchive(config);
    assert.ok(archive.search(scope).items.some(row => row.text === '已成功发送的回答'));
    const delivered = archive.findMessage(scope, 'delivered-ref');
    assert.equal(delivered.messageId, 'delivered-1');
    assert.equal(delivered.replyToId, 'first');
    assert.equal(delivered.platformIdKnown, true);
    success = false;
    await runDSHChat({ ...event, MessageId: 'second' }, '再聊聊', { transport });
    assert.equal(archive.search(scope, { keyword: '不应归档' }).items.length, 0);
  } finally {
    await (await getModuleRuntime(config)).close();
    getChatArchive(config).close();
    globalThis.fetch = originalFetch;
    globalThis.__config = originalConfig;
    await rm(root, { recursive: true, force: true });
  }
});
