import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageReferences, expandForwardedContent } from '../lib/social/references.js';

const event = overrides => ({ Platform: 'qq', BotId: 'bot', ChannelId: 'group', UserId: 'one', MessageId: 'm1', MessageText: '原文', ...overrides });

test('observed and confirmed reply references remain scoped and are removed on reset', async () => {
  const references = new MessageReferences();
  await references.capture(event());
  assert.equal((await references.capture(event({ MessageId: 'm2', ReplyId: 'm1' }))).quote.text, '原文');
  assert.equal((await references.capture(event({ ChannelId: 'other', MessageId: 'm3', ReplyId: 'm1' }))).quote, undefined);
  assert.equal((await references.capture(event({ Platform: 'other', MessageId: 'm4', ReplyId: 'm1' }))).quote, undefined);
  await references.rememberReply(event(), { id: 'bot-reply', referenceId: 'bot-ref' }, '真实回复');
  const quoted = await references.capture(event({ MessageId: 'm5', ReplyId: 'bot-ref' }));
  assert.equal(quoted.quote.isBot, true);
  assert.equal(quoted.quote.text, '真实回复');
  await references.clear('group');
  assert.equal((await references.capture(event({ MessageId: 'm6', ReplyId: 'bot-ref' }))).quote, undefined);
});

test('normalized quoted content is readable without pretending an unavailable reference is known', async () => {
  const references = new MessageReferences();
  const result = await references.capture(
    event({
      MessageContent: {
        replyReferenceId: 'unseen',
        elements: [
          {
            referenceId: 'unseen',
            userName: '对方',
            text: '引用原文',
            content: {},
            author: { IsBot: true }
          }
        ]
      }
    })
  );
  assert.equal(result.quote.text, '引用原文');
  assert.equal(result.quote.isBot, true);
  const missing = await references.capture(event({ MessageId: 'new', ReplyId: 'missing' }));
  assert.equal(missing.quote, undefined);
  assert.equal(missing.missingQuote, 'missing');
});

test('forward expansion is bounded, preserves attribution and excludes the explicit quote', () => {
  const nested = { elements: [{ userName: '成员', text: '转发正文', content: { elements: [{ text: '内层', content: {} }] } }] };
  const rows = JSON.parse(expandForwardedContent(nested));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sender, '成员');
  assert.equal(rows[1].text, '内层');
  const many = { elements: Array.from({ length: 100 }, () => ({ text: '鲸'.repeat(2000), content: {} })) };
  const limited = JSON.parse(expandForwardedContent(many));
  assert.ok(limited.length <= 24);
  assert.ok(limited.reduce((n, r) => n + r.text.length, 0) <= 6000);
  assert.equal(expandForwardedContent({ replyReferenceId: 'quote', elements: [{ referenceId: 'quote', text: '单独引用', content: {} }] }), '');
});

test('reset is ordered after pending capture and also clears output-only reference scopes', async () => {
  const references = new MessageReferences();
  const captured = references.capture(event());
  const cleared = references.clear('group');
  await captured;
  await cleared;
  assert.equal((await references.capture(event({ MessageId: 'after-reset', ReplyId: 'm1' }))).quote, undefined);
  await references.rememberReply(event({ ChannelId: 'output-only' }), { id: 'bot-only' }, '旧回复');
  await references.clear('output-only');
  assert.equal((await references.capture(event({ ChannelId: 'output-only', MessageId: 'next', ReplyId: 'bot-only' }))).quote, undefined);
});

test('unified references expose quote provenance, forward quoted images once and label unread media', async () => {
  const references = new MessageReferences();
  const picture = { Type: 'image', Url: 'https://cdn.test/quoted.png', FileName: '原图.png' };
  await references.capture(event({ MessageMedia: [picture, { Type: 'video', Url: 'https://cdn.test/video' }] }));
  const prepared = await references.prepare(event({ MessageId: 'quoted', MessageText: '解释这个', ReplyId: 'm1', MessageMedia: [picture] }));
  const context = JSON.parse(prepared.context);
  assert.equal(context.hasQuote, true);
  assert.equal(context.quote.text, '原文');
  assert.equal(context.quote.senderId, 'one');
  assert.equal(context.quote.attachments[0].inputAttachment, 1);
  assert.match(context.quote.attachments[1].status, /未读取/);
  assert.deepEqual(prepared.media, [picture]);
  const missing = JSON.parse((await references.prepare(event({ MessageId: 'missing-current', MessageContent: { replyReferenceId: 'unseen' } }))).context);
  assert.equal(missing.hasQuote, true);
  assert.match(missing.unavailableQuote, /不能猜测/);
});

test('private references isolate users, and sent text does not inherit incoming quoted media', async () => {
  const references = new MessageReferences();
  const incoming = {
    Platform: 'qq',
    BotId: 'bot',
    UserId: 'private-one',
    IsPrivate: true,
    MessageId: 'original',
    MessageText: '私聊原文',
    MessageMedia: [{ Type: 'image', Url: 'https://cdn.test/p.png' }]
  };
  await references.capture(incoming);
  assert.equal(JSON.parse((await references.prepare({ ...incoming, MessageId: 'question', ReplyId: 'original' })).context).quote.text, '私聊原文');
  assert.match(
    JSON.parse((await references.prepare({ ...incoming, UserId: 'private-two', MessageId: 'other', ReplyId: 'original' })).context).unavailableQuote,
    /不可用/
  );
  await references.rememberReply({ ...incoming, ChannelId: 'private-scope' }, { id: 'sent' }, '仅文字回复');
  const reply = await references.prepare({ ...incoming, ChannelId: 'private-scope', MessageId: 'next', ReplyId: 'sent', MessageMedia: [] });
  // The outgoing reply must not be indexed with the user's incoming image.
  assert.equal(JSON.parse(reply.context).quote.text, '仅文字回复');
  assert.deepEqual(JSON.parse(reply.context).quote.attachments, []);
  await references.clear('private:' + JSON.stringify(['qq', 'private-one']));
  const cleared = await references.prepare({ ...incoming, MessageId: 'cleared', ReplyId: 'sent', MessageMedia: [] });
  assert.match(JSON.parse(cleared.context).unavailableQuote, /不可用/);
});
