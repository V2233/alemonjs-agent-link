import test from 'node:test';
import assert from 'node:assert/strict';
import { Format, getConfig, ResultCode } from 'alemonjs';
import { createChatReplyFormat } from '../lib/dsh/reply-format.js';

const { GROUP_AT_MESSAGE_CREATE } = await import(new URL('./sends.js', import.meta.resolve('@alemonjs/qq-bot')));
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));

test('actual QQ adapter uses a Markdown envelope for framework mentions instead of leaking tags into Text', async () => {
  const sent = [];
  const client = { groupOpenMessages: async (group, body) => { sent.push({ group, body }); return { id: 'reply' }; } };
  await runtimeScope.run({ resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now }, async () => {
    getConfig().saveValue({ 'qq-bot': { markdownToText: false } });
    // Reproduce the reported mixed Mention + Text failure with the real adapter.
    await GROUP_AT_MESSAGE_CREATE(client, { ChannelId: 'group' }, Format.create().addMention('user').addText('\n在的'), { replyId: 'incoming' });
    const result = await GROUP_AT_MESSAGE_CREATE(client, { ChannelId: 'group' }, createChatReplyFormat('在的', 'qq-bot', 'user'), { replyId: 'incoming' });
    assert.equal(result[0].code, ResultCode.Ok);
  });
  assert.equal(sent[0].body.msg_type, 0);
  assert.match(sent[0].body.content, /<qqbot-at-user/);
  assert.equal(sent[1].body.msg_type, 2);
  assert.equal(sent[1].body.content, undefined);
  assert.match(sent[1].body.markdown.content, /<qqbot-at-user id="user"\s*\/>/);
  assert.match(sent[1].body.markdown.content, /在的/);
  assert.equal(sent[1].body.msg_id, 'incoming');
});

test('private replies and later chunks stay Text; OneBot keeps its native Mention node', () => {
  assert.deepEqual(createChatReplyFormat('你好', 'qq-bot'), Format.create().addText('你好'));
  assert.deepEqual(createChatReplyFormat('你好', 'onebot', 'user'), Format.create().addMention('user').addText('\n').addText('你好'));
});
