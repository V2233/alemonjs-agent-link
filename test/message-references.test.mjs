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
