import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultCode } from 'alemonjs';
import { runDSHChat } from '../lib/response/dsh/chat.js';
import { messageReferences } from '../lib/social/references.js';
import { submitGroupChat } from '../lib/social/respond.js';
import { groupConversations } from '../lib/social/groups.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';

test('private quoted text reaches the actual model; group text and voice commands carry quote context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quote-input-'));
  const oldConfig = globalThis.__config,
    oldFetch = globalThis.fetch,
    oldReceive = groupConversations.receive;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'workspaces'),
        dshHomeRoot: join(root, 'homes'),
        modules: { settings: { mood: { modelJudge: false }, expression: { automatic: false } } }
      }
    }
  };
  const config = getDSHConfig();
  const event = {
    Platform: 'qq',
    BotId: 'bot',
    UserId: 'owner',
    UserKey: 'owner',
    IsPrivate: true,
    IsMaster: true,
    MessageId: 'question',
    ReplyId: 'original'
  };
  const transport = {
    message: { send: async () => [{ code: ResultCode.Ok, data: { id: 'reply' } }] },
    media: { send: async () => assert.fail('not a media response') }
  };
  let calls = 0;
  try {
    await messageReferences.capture({ ...event, MessageId: 'original', ReplyId: undefined, MessageText: '这是私聊引用原文' });
    globalThis.fetch = async (_url, options) => {
      calls++;
      const input = JSON.stringify(JSON.parse(options.body).messages);
      assert.match(input, /这是私聊引用原文/);
      assert.match(input, /hasQuote/);
      return Response.json({ choices: [{ message: { content: '我看到了引用内容。' } }] });
    };
    await runDSHChat(event, '解释一下', { transport });
    assert.equal(calls, 1);
    const group = {
      ...event,
      IsPrivate: false,
      ChannelId: 'reference-command',
      MessageContent: { replyReferenceId: 'unseen', elements: [{ referenceId: 'unseen', text: '命令引用原文', content: {} }] }
    };
    groupConversations.receive = async input => {
      assert.equal(JSON.parse(input.referenceContext).quote.text, '命令引用原文');
      assert.equal(input.explicitCommand, true);
      return { reply: false, mode: 'none', reason: 'test', relevance: 0 };
    };
    await submitGroupChat(group, '解释一下', transport);
    await submitGroupChat(group, '读一下', transport, true);
  } finally {
    groupConversations.receive = oldReceive;
    await messageReferences.clear('reference-command');
    await messageReferences.clear('private:' + JSON.stringify(['qq', 'owner']));
    await (await getModuleRuntime(config)).close();
    globalThis.__config = oldConfig;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});
