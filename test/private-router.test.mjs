import test from 'node:test';
import assert from 'node:assert/strict';
import { withEventContext } from 'alemonjs';
import router from '../lib/router.js';
import capture from '../lib/response/chat-context/capture.js';
import history from '../lib/response/history-capture/res.js';
import group from '../lib/response/dsh/res.js';
import privateChat from '../lib/response/private-chat/res.js';
import lifecycle from '../lib/response/platform-events/res.js';
import { contextEvents } from '../lib/social/event-context.js';

test('actual router keeps message and lifecycle res event scopes separate', async () => {
  const expected = new Map([
    [capture, ['message.create']],
    [group, ['message.create']],
    [privateChat, ['private.message.create']],
    [lifecycle, [...contextEvents]]
  ]);
  for (const route of router.current) {
    const handler = await route.handler();
    if (expected.has(handler)) assert.deepEqual(route.selects, expected.get(handler));
  }
});

test('plain private calls reach the private chat entry through the actual command scope', async () => {
  for (const MessageText of ['你在吗', '肥鱼你在吗', '肥鱼']) {
    const event = {
      name: 'private.message.create',
      Platform: 'qq-bot',
      IsPrivate: true,
      IsMaster: true,
      IsBot: false,
      UserId: 'test-owner',
      MessageId: 'test-message',
      MessageText
    };
    let reached = false;
    const dispatch = async index => {
      if (index >= router.current.length) return;
      const route = router.current[index];
      const next = () => dispatch(index + 1);
      if (route.selects && ![].concat(route.selects).includes(event.name)) return next();
      const handler = await route.handler();
      if (handler === history) return next(); // No persistent writes in this route-only regression.
      if (handler === privateChat) {
        reached = true;
        return;
      }
      return withEventContext(event, next, () => handler(event, next));
    };
    await dispatch(0);
    assert.equal(reached, true, MessageText + ' must reach the model entry, not be silently consumed by a group handler');
  }
});

test('mismatched group handlers explicitly pass private events downstream', async () => {
  const event = { name: 'private.message.create', Platform: 'qq-bot', IsPrivate: true, MessageText: '你在吗' };
  for (const handler of [capture, group]) {
    let passed = false;
    await withEventContext(
      event,
      () => {
        passed = true;
      },
      () => handler()
    );
    assert.equal(passed, true);
  }
});
