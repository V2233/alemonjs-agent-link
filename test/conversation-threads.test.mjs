import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationThreads } from '../lib/social/conversation-threads.js';
const speaker = (userId, platform = 'qq') => ({ userId, userKey: `${platform}:${userId}`, platform, text: `${userId}的问题` });
const send = (threads, person, at = 0, reply = '回答') => threads.delivered(person, reply, at, threads.begin(person, at));

test('exchanges stay isolated by speaker and platform, expire, and remain bounded', () => {
  const threads = new ConversationThreads();
  send(threads, speaker('a'), 0, '甲的回答');
  send(threads, speaker('b'), 1, '乙的回答');
  send(threads, speaker('a', 'onebot'), 2, '另一平台');
  assert.equal(threads.exchange(speaker('a'), 3).replyText, '甲的回答');
  assert.equal(threads.exchange(speaker('b'), 3).replyText, '乙的回答');
  assert.equal(threads.exchange(speaker('a', 'onebot'), 3).replyText, '另一平台');
  assert.equal(threads.exchange(speaker('a'), 120000), undefined);
  for (let i = 0; i < 101; i++) send(threads, speaker(String(i)), 120001);
  assert.equal(threads.exchange(speaker('0'), 120002), undefined);
  assert.equal(threads.exchange(speaker('100'), 120002).replyText, '回答');
});

test('ending or invalidating a conversation cannot be undone by a late delivery', () => {
  for (const clear of ['end', 'user', 'all']) {
    const threads = new ConversationThreads();
    const person = speaker('a');
    const ticket = threads.begin(person, 0);
    send(threads, speaker('b'), 0);
    if (clear === 'end') threads.end(person);
    else threads.clear(clear === 'user' ? person.userKey : undefined);
    threads.delivered(person, '迟来的回答', 1, ticket);
    assert.equal(threads.exchange(person, 2), undefined);
    if (clear !== 'all') assert.ok(threads.exchange(speaker('b'), 2));
  }
});

test('only confirmed nonempty replies can create continuation context and text is bounded', () => {
  const threads = new ConversationThreads();
  const person = { ...speaker('a'), text: 'a'.repeat(5000) };
  const ticket = threads.begin(person, 0);
  assert.equal(threads.exchange(person, 1), undefined);
  threads.delivered(person, ' ', 1, ticket);
  assert.equal(threads.exchange(person, 2), undefined);
  threads.delivered(person, 'b'.repeat(5000), 3, ticket);
  assert.equal(threads.exchange(person, 4).userText.length, 1000);
  assert.equal(threads.exchange(person, 4).replyText.length, 2000);
});
