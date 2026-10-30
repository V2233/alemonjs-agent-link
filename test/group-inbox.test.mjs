import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ChatArchive, getChatArchive } from '../lib/history/store.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime, executeTool } from '../lib/agent/modules.js';
import { runModuleTurn } from '../lib/agent/turn.js';
import { conversationModule } from '../lib/modules/conversation.js';
const scope = { platform: 'qq', channelId: 'group' };
const msg = (id, text = id, extra = {}) => ({ id, text, role: 'user', speakerId: 'alice', speaker: '甲', platformIdKnown: true, ...extra });
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'group-inbox-'));
  const path = join(root, 'archive.sqlite');
  let archive = new ChatArchive(path);
  try {
    await run({
      root,
      path,
      get archive() {
        return archive;
      },
      reopen() {
        archive.close();
        archive = new ChatArchive(path);
      }
    });
  } finally {
    archive.close();
    await rm(root, { recursive: true, force: true });
  }
};

test('snapshot pages and acknowledgments never erase later messages, regress progress or mix scopes/bots', async () =>
  fixture(async f => {
    for (const id of ['1', '2', '3']) f.archive.append(scope, msg(id));
    f.archive.append({ ...scope, platform: 'other' }, msg('secret', '另一平台秘密'));
    const one = f.archive.readGroupInbox(scope, 'bot-a', 1);
    assert.deepEqual(
      one.sources.map(row => row.text),
      ['1']
    );
    assert.equal(one.hasMore, true);
    f.archive.append(scope, msg('4', '读取之后新到的消息'));
    const two = f.archive.readGroupInbox(scope, 'bot-a', 2, one.receipt);
    assert.deepEqual(
      two.sources.map(row => row.text),
      ['2', '3']
    );
    assert.equal(two.upper, one.upper);
    assert.equal(f.archive.acknowledgeGroupInbox(scope, 'bot-b', two.receipt).ok, false);
    assert.equal(f.archive.acknowledgeGroupInbox({ ...scope, channelId: 'another' }, 'bot-a', two.receipt).ok, false);
    assert.equal(f.archive.acknowledgeGroupInbox(scope, 'bot-a', two.receipt).ok, true);
    const checkpoint = f.archive.acknowledgeGroupInbox(scope, 'bot-a', one.receipt).checkpoint;
    assert.equal(checkpoint, two.through);
    f.reopen();
    assert.equal(f.archive.acknowledgeGroupInbox(scope, 'bot-a', two.receipt).checkpoint, checkpoint);
    assert.deepEqual(
      f.archive.readGroupInbox(scope, 'bot-a').sources.map(row => row.messageId),
      ['4']
    );
    assert.deepEqual(
      f.archive.readGroupInbox(scope, 'bot-b').sources.map(row => row.messageId),
      ['1', '2', '3', '4']
    );
  }));

test('recent inbox excludes old and assistant statements, bounds excerpts and does not acknowledge on read', async () =>
  fixture(async f => {
    f.archive.append(scope, msg('old', '旧请求', { timestamp: Date.now() - 16 * 60000 }));
    f.archive.append(scope, msg('own', '机器人自己的回答', { role: 'assistant' }));
    f.archive.append(scope, msg('current', '文'.repeat(9000), { replyToId: 'own' }));
    const read = f.archive.readGroupInbox(scope, 'bot');
    assert.equal(read.sources.length, 1);
    assert.equal(read.sources[0].text.length, 600);
    assert.equal(read.sources[0].truncated, true);
    assert.equal(read.sources[0].replyToId, 'own');
    assert.equal(read.sources[0].platformIdKnown, true);
    assert.equal(f.archive.readGroupInbox(scope, 'bot').sources.length, 1);
    assert.equal(f.archive.acknowledgeGroupInbox(scope, 'bot', 'invented-checkpoint-99999').ok, false);
    for (const limit of [0, 21, 1.5]) assert.throws(() => f.archive.readGroupInbox(scope, 'bot', limit));
    assert.throws(() => f.archive.readGroupInbox(scope, '', 1));
  }));

test('deleting sources invalidates issued receipts and purging removes persisted progress', async () =>
  fixture(async f => {
    for (const action of ['invalidate', 'purge', 'purgeHash']) {
      f.archive.append(scope, msg(action));
      const read = f.archive.readGroupInbox(scope, 'bot');
      if (action === 'invalidate') f.archive.invalidate(scope, action);
      else if (action === 'purge') f.archive.purge(scope);
      else f.archive.purgeHash(createHash('sha256').update(scope.channelId).digest('hex'));
      assert.equal(f.archive.acknowledgeGroupInbox(scope, 'bot', read.receipt).ok, false);
      assert.throws(() => f.archive.readGroupInbox(scope, 'bot', 20, read.receipt), /回执/);
    }
    f.archive.append(scope, msg('after-cleanup'));
    const fresh = f.archive.readGroupInbox(scope, 'bot');
    assert.equal(fresh.checkpoint, 0);
    assert.equal(fresh.sources[0].messageId, 'after-cleanup');
  }));

test('receipt expiry and bounded receipt history reject stale acknowledgments', async () =>
  fixture(async f => {
    f.archive.append(scope, msg('1'));
    const oldest = f.archive.readGroupInbox(scope, 'bot');
    for (let i = 0; i < 100; i++) f.archive.readGroupInbox(scope, 'bot');
    assert.equal(f.archive.acknowledgeGroupInbox(scope, 'bot', oldest.receipt).ok, false);
    const read = f.archive.readGroupInbox(scope, 'bot');
    const db = new DatabaseSync(f.path);
    try {
      db.prepare('UPDATE group_inbox_receipts SET issued_at=? WHERE id=?').run(Date.now() - 16 * 60000, read.receipt);
    } finally {
      db.close();
    }
    assert.equal(f.archive.acknowledgeGroupInbox(scope, 'bot', read.receipt).ok, false);
  }));

test('the model reads real scoped archive sources and acknowledges only the returned snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-inbox-turn-'));
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
        modules: { disabled: ['mood', 'opinions', 'proactive', 'memory'] }
      }
    }
  };
  const config = getDSHConfig();
  const archive = getChatArchive(config);
  archive.append(scope, msg('seen', '甲刚才在找海洋资料'));
  archive.append({ ...scope, channelId: 'private:secret' }, msg('hidden', '不应读取的私聊资料'));
  let calls = 0;
  let receipt;
  const call = (id, name, args) =>
    Response.json({ choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.ok(body.tools.some(tool => tool.function.name === 'read_group_inbox'));
    assert.ok(!JSON.stringify(body.messages).includes('不应读取的私聊资料'));
    if (calls === 1) return call('read', 'read_group_inbox', { limit: 20 });
    const results = body.messages.filter(row => row.role === 'tool').map(row => JSON.parse(row.content));
    if (calls === 2) {
      assert.equal(results[0].sources[0].text, '甲刚才在找海洋资料');
      receipt = results[0].receipt;
      archive.append(scope, msg('later', '读取之后的新消息'));
      return call('ack', 'ack_group_inbox', { receipt });
    }
    assert.equal(results.at(-1).ok, true);
    return Response.json({ choices: [{ message: { content: '原来是在找海洋资料。' } }] });
  };
  const observedSpeakers = [];
  const context = {
    ...scope,
    botId: 'bot',
    userId: 'alice',
    private: false,
    owner: false,
    userText: '接上刚才的话题',
    onGroupWait: () => ({ ok: true, state: 'idle' }),
    onGroupInboxSpeakers: ids => observedSpeakers.push(...ids),
    capabilities: { chat: true, web: false, files: false, terminal: false },
    signal: new AbortController().signal
  };
  try {
    await runModuleTurn({ config, sessionId: 'inbox-test', input: context.userText, context, onEvent: () => Promise.resolve() });
    assert.equal(calls, 3);
    assert.deepEqual(observedSpeakers, ['alice']);
    assert.deepEqual(
      archive.readGroupInbox(scope, 'bot').sources.map(row => row.messageId),
      ['later']
    );
    const tools = [];
    conversationModule(config).setup({ tool: tool => tools.push(tool) });
    const read = tools.find(tool => tool.name === 'read_group_inbox');
    for (const patch of [{ private: true }, { autonomous: true }, { botId: undefined }, { onGroupWait: undefined }])
      assert.equal(read.available({ ...context, ...patch }), false);
    await assert.rejects(executeTool(read, { channelId: 'private:secret' }, context), /invalid|未知|参数/i);
    globalThis.__config.value['alemonjs-agent-link'].modules.disabled.push('chat-history');
    assert.equal(read.available(context), false);
  } finally {
    await (await getModuleRuntime(config)).close();
    archive.close();
    globalThis.__config = previous.config;
    globalThis.fetch = previous.fetch;
    await rm(root, { recursive: true, force: true });
  }
});
