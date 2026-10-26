import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessageContext, readMessageContext } from '../lib/social/message-context.js';
import { buildGroupBatchPrompt } from '../lib/social/group-conversation.js';
import { MessageFragments } from '../lib/social/message-fragments.js';

test('mentions distinguish self, other bots and unknown names without exposing raw event fields', () => {
  const event = { BotId: 'fish', IsAtMe: true, value: { secret: 'hidden-token' } };
  const context = buildMessageContext(
    event,
    [
      { UserId: 'fish', UserName: '肥鱼', IsBot: true },
      { UserId: 'other-bot', IsBot: true },
      { UserId: 'person', UserName: '柠檬' },
      { UserId: 'person', UserName: '柠檬' }
    ],
    'mention'
  );
  assert.equal(context.mentions.length, 3);
  assert.deepEqual(context.mentions[1], { id: 'other-bot', name: null, isSelf: false, isBot: true });
  assert.equal(context.mentions[0].isSelf, true);
  assert.equal(context.mentionedSelf, true);
  assert.equal(JSON.stringify(context).includes('hidden-token'), false);
});

test('missing mention data is different from a known empty list', async () => {
  const unknown = buildMessageContext({ IsAtMe: true }, undefined, 'mention');
  assert.equal(unknown.mentionsKnown, false);
  assert.equal(unknown.mentionedSelf, true);
  assert.equal(buildMessageContext({}, [{ UserId: 'bot', IsBot: true }], 'ambient').mentions[0].isSelf, null);
  const empty = await readMessageContext({ MessageMentions: [] }, 'private');
  assert.equal(empty.mentionsKnown, true);
  assert.deepEqual(empty.mentions, []);
});

test('mention lists and names are bounded', () => {
  const context = buildMessageContext(
    {},
    Array.from({ length: 30 }, (_, index) => ({ UserId: String(index), UserName: 'x'.repeat(200) })),
    'command'
  );
  assert.equal(context.mentions.length, 20);
  assert.equal(context.mentionsTruncated, true);
  assert.equal(context.mentions[0].name.length, 80);
});

test('batched and held messages keep their own speaker, mentions, trigger and quote', () => {
  const first = {
    channelId: 'group',
    id: 'first',
    platform: 'test',
    userId: 'alice',
    name: 'Alice',
    text: '@Bob 他说得对吗',
    direct: false,
    messageContext: buildMessageContext({ BotId: 'fish' }, [{ UserId: 'bob', UserName: 'Bob' }], 'ambient'),
    referenceContext: '原文来自 Bob'
  };
  const second = {
    ...first,
    id: 'second',
    userId: 'carol',
    name: 'Carol',
    text: '肥鱼你怎么看',
    direct: true,
    messageContext: buildMessageContext({ BotId: 'fish' }, [], 'wake_name'),
    referenceContext: undefined
  };
  const fragments = new MessageFragments();
  fragments.save([first], 0, true);
  const recovered = fragments.take(first, 1);
  const prompt = buildGroupBatchPrompt({ mode: 'direct', id: 'batch', messages: [...recovered, second], anchor: second });
  const messages = JSON.parse(prompt.split('\n').at(-1));
  assert.equal(messages[0].speaker.id, 'alice');
  assert.equal(messages[0].messageContext.mentions[0].id, 'bob');
  assert.equal(messages[0].messageContext.mentions[0].isSelf, false);
  assert.equal(messages[0].references, '原文来自 Bob');
  assert.equal(messages[1].speaker.id, 'carol');
  assert.equal(messages[1].messageContext.trigger, 'wake_name');
  assert.deepEqual(messages[1].messageContext.mentions, []);
});

test('context preserves conversation, platform identity, time and reply edges without exposing transport secrets', () => {
  const context = buildMessageContext(
    {
      Platform: 'onebot',
      BotId: 'bot',
      ChannelId: 'group',
      GuildId: 'guild',
      Target: { scope: 'group', targetId: 'group' },
      UserId: 'alice',
      UserName: '群名片',
      Role: 'admin',
      IsAdmin: true,
      IsBot: false,
      name: 'message.create',
      MessageId: 'm2',
      ReplyId: 'm1',
      OccurredAt: 1000,
      CreateAt: 2500,
      value: { token: 'transport-secret' },
      UserAvatar: 'signed-avatar-url'
    },
    [],
    'ambient'
  );
  assert.equal(context.conversation.scope, 'group');
  assert.equal(context.sender.platformRole, 'admin');
  assert.equal(context.sender.id, 'alice');
  assert.equal(context.message.replyToId, 'm1');
  assert.equal(context.time.occurredAt, '1970-01-01T00:00:01.000Z');
  assert.equal(context.time.receivedAt, '1970-01-01T00:00:02.500Z');
  assert.doesNotMatch(JSON.stringify(context), /transport-secret|signed-avatar-url/);
  const missing = buildMessageContext({ IsPrivate: true, OccurredAt: NaN, CreateAt: Infinity }, undefined, 'private');
  assert.equal(missing.conversation.scope, 'private');
  assert.equal(missing.sender.platformRole, null);
  assert.deepEqual(missing.time, { occurredAt: null, receivedAt: null });
});

test('attachment metadata never implies content was read and excludes signed media URLs', () => {
  const context = buildMessageContext(
    {
      MessageMedia: [
        { Type: 'image', FileName: '图片.png', MimeType: 'image/png', Width: 800, Height: 600, Url: 'signed-secret-url' },
        { Type: 'audio', Transcript: '实际平台转写', FileSize: 100 }
      ]
    },
    [],
    'private'
  );
  assert.equal(context.attachments[0].contentStatus, 'metadata_only_content_not_yet_read');
  assert.equal(context.attachments[0].width, 800);
  assert.equal(context.attachments[1].transcript, '实际平台转写');
  assert.equal(context.attachments[1].contentStatus, 'platform_transcript_available');
  assert.doesNotMatch(JSON.stringify(context), /signed-secret-url/);
});
