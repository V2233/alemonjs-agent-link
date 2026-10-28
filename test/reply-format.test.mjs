import test from 'node:test';
import assert from 'node:assert/strict';
import { Format, getConfig, ResultCode } from 'alemonjs';
import { createChatReplyFormat, normalizeBubbleText, ReplyPrefixFilter } from '../lib/dsh/reply-format.js';

const { GROUP_AT_MESSAGE_CREATE } = await import(new URL('./sends.js', import.meta.resolve('@alemonjs/qq-bot')));
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));

test('actual QQ adapter uses a Markdown envelope for framework mentions instead of leaking tags into Text', async () => {
  const sent = [];
  const client = {
    groupOpenMessages: async (group, body) => {
      sent.push({ group, body });
      return { id: 'reply' };
    }
  };
  await runtimeScope.run({ resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now }, async () => {
    getConfig().saveValue({ 'qq-bot': { markdownToText: false } });
    // Reproduce the reported mixed Mention + Text failure with the real adapter.
    await GROUP_AT_MESSAGE_CREATE(client, { ChannelId: 'group' }, Format.create().addMention('user').addText('\n在的').value, { replyId: 'incoming' });
    const result = await GROUP_AT_MESSAGE_CREATE(client, { ChannelId: 'group' }, createChatReplyFormat('在的', 'qq-bot', 'user').value, {
      replyId: 'incoming'
    });
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
  assert.deepEqual(createChatReplyFormat('你好', 'qq-bot').value, Format.create().addText('你好').value);
  assert.deepEqual(createChatReplyFormat('你好', 'onebot', 'user').value, Format.create().addMention('user').addText('\n').addText('你好').value);
});

test('streaming only waits for a possible routing prefix and never buffers the full answer', () => {
  const filter = new ReplyPrefixFilter();
  assert.equal(filter.push('<rep'), '');
  assert.equal(filter.push('ly:m'), '');
  assert.equal(filter.push('1>第一句。'), '第一句。');
  assert.equal(filter.push('后半句'), '后半句');
  assert.equal(new ReplyPrefixFilter().push('直接回答。'), '直接回答。');
});

test('bubble markers are transport-only and never enter stored text', () => {
  assert.equal(normalizeBubbleText('第一句|||第二句'), '第一句\n第二句');
  assert.equal(normalizeBubbleText('  单句  '), '单句');
});
