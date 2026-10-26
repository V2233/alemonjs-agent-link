import test from 'node:test';
import assert from 'node:assert/strict';
import { EventContextStore, contextEvents } from '../lib/social/event-context.js';
import { MessageReferences } from '../lib/social/references.js';
const event = { Platform: 'qq', BotId: 'bot', ChannelId: 'one', UserId: 'user', MessageId: 'm1' };

test('supported lifecycle events become bounded scoped facts, never arbitrary notice payloads', () => {
  let now = 1000;
  const store = new EventContextStore(() => now);
  for (const name of contextEvents) {
    assert.equal(store.record({ ...event, name, EventId: name, MessageText: 'notice secret', RawMessageText: 'raw secret' }), true);
  }
  const context = store.context(event);
  assert.ok(context.includes('notice.create'));
  assert.doesNotMatch(context, /raw secret/);
  assert.doesNotMatch(context, /notice secret/);
  assert.equal(store.record({ ...event, name: 'notice.create', EventId: 'notice.create' }), false);
  assert.equal(store.record({ ...event, name: 'private.friend.add' }), false);
  assert.equal(store.context({ ...event, ChannelId: 'two' }), '');
  assert.equal(store.context({ ...event, BotId: 'other' }), '');
  assert.equal(store.context({ ...event, Platform: 'other' }), '');
  now += 600001;
  assert.equal(store.context(event), '');
});

test('private events use the private scope even if adapter omitted IsPrivate', () => {
  const store = new EventContextStore();
  store.record({ ...event, name: 'private.message.delete' });
  assert.match(store.context({ ...event, IsPrivate: true }), /消息已撤回/);
  assert.equal(store.context(event), '');
  assert.equal(store.context({ ...event, IsPrivate: true, UserId: 'other' }), '');
});

test('message invalidation removes stale quote aliases only within the current scope and edits can replace them', async () => {
  const references = new MessageReferences();
  await references.capture({ ...event, MessageText: '旧正文', MessageContent: { referenceId: 'ref1' } });
  await references.capture({ ...event, ChannelId: 'two', MessageText: '另一个群' });
  await references.invalidate({ ...event, MessageContent: { referenceId: 'ref1' } });
  assert.equal((await references.capture({ ...event, MessageId: 'new', ReplyId: 'ref1' })).quote, undefined);
  assert.equal((await references.capture({ ...event, ChannelId: 'two', MessageId: 'new', ReplyId: 'm1' })).quote.text, '另一个群');
  await references.capture({ ...event, MessageText: '新正文' });
  assert.equal((await references.capture({ ...event, MessageId: 'edit-quote', ReplyId: 'm1' })).quote.text, '新正文');
});

test('lifecycle facts distinguish an operator from the affected member and keep occurrence time', () => {
  const store = new EventContextStore(() => 5000);
  store.record({
    ...event,
    name: 'message.delete',
    OccurredAt: 1000,
    CreateAt: 2000,
    PlatformAction: { kind: 'recall', actorId: 'admin', subjectId: 'user', raw: 'secret' }
  });
  const text = store.context(event);
  assert.match(text, /"actorId":"admin"/);
  assert.match(text, /"subjectId":"user"/);
  assert.match(text, /1970-01-01T00:00:01.000Z/);
  assert.doesNotMatch(text, /secret/);
});
