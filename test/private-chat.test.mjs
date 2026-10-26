import test from 'node:test';
import assert from 'node:assert/strict';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getConversationId, canPrivateChat, isPrivateChatText } from '../lib/response/dsh/util.js';
import { SessionRegistry, publicPrivatePolicy } from '../lib/state/registry.js';
import { directChat } from '../lib/dsh/direct-chat.js';

test('private identities isolate platforms and users and reject missing identity', () => {
  const a = { IsPrivate: true, Platform: 'qq', UserId: '1' };
  assert.notEqual(getConversationId(a), getConversationId({ ...a, UserId: '2' }));
  assert.notEqual(getConversationId(a), getConversationId({ ...a, Platform: 'discord' }));
  assert.equal(getConversationId({ IsPrivate: true, IsMaster: true }), '');
  assert.equal(getConversationId({ ChannelId: 'group' }), 'group');
  assert.equal(canPrivateChat(a, 'owner'), false);
  assert.equal(canPrivateChat(a, 'all'), true);
  assert.equal(canPrivateChat({ ...a, IsMaster: true }, 'owner'), true);
  assert.deepEqual(publicPrivatePolicy, { version: 1, chat: true, web: false, files: false, terminal: false });
  for (const text of ['', ' ', '/new', ' /chat hi', '/unknown']) assert.equal(isPrivateChatText(text), false);
  assert.equal(isPrivateChatText('今天好累'), true);
});

test('persona defaults, custom override and private config validation', () => {
  assert.match(getDSHConfig({}).defaultSystemPrompt, /大肥鱼/);
  const cfg = values => getDSHConfig({ 'alemonjs-agent-link': values });
  assert.equal(cfg({ defaultSystemPrompt: 'custom' }).defaultSystemPrompt, 'custom');
  assert.doesNotMatch(cfg({ persona: 'assistant' }).defaultSystemPrompt, /大肥鱼/);
  assert.equal(cfg({}).privateChatAccess, 'owner');
  for (const invalid of [
    { privateChatAccess: 'everyone' },
    { privateAutoReply: 'false' },
    { persona: 'unknown' },
    { privateHistoryMaxTurns: -1 },
    { privateHistoryMaxTurns: 101 },
    { privateHistoryTtlSeconds: 0 },
    { privateHistoryMaxChars: 0 }
  ]) {
    assert.throws(() => cfg(invalid));
  }
});

test('direct private chat passes structured history and saves only completed, uncancelled turns', async () => {
  const oldFetch = globalThis.fetch;
  const oldRead = SessionRegistry.prototype.privateHistory;
  const oldAppend = SessionRegistry.prototype.appendPrivateTurn;
  const context = { channelId: 'private:test', generation: 3 };
  const history = [
    { role: 'user', content: '我叫小明' },
    { role: 'assistant', content: '你好小明' }
  ];
  const saved = [];
  SessionRegistry.prototype.privateHistory = async function (received) {
    assert.deepEqual(received, context);
    return history;
  };
  SessionRegistry.prototype.appendPrivateTurn = async function (...args) {
    saved.push(args);
  };
  let failure = false;
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).messages.slice(1), [...history, { role: 'user', content: '我叫什么' }]);
    if (failure) throw new Error('offline');
    return Response.json({ choices: [{ message: { content: '你叫小明' } }] });
  };
  const config = getDSHConfig({});
  try {
    await directChat(config, { apiKey: 'test' }, '我叫什么', new AbortController().signal, async () => {}, context);
    assert.deepEqual(saved, [[context, '我叫什么', '你叫小明']]);
    failure = true;
    await assert.rejects(directChat(config, { apiKey: 'test' }, '我叫什么', new AbortController().signal, async () => {}, context));
    failure = false;
    const controller = new AbortController();
    await assert.rejects(directChat(config, { apiKey: 'test' }, '我叫什么', controller.signal, async () => controller.abort(), context));
    await assert.rejects(
      directChat(
        config,
        { apiKey: 'test' },
        '我叫什么',
        new AbortController().signal,
        async () => {},
        context,
        async () => {
          throw new Error('delivery failed');
        }
      )
    );
    assert.equal(saved.length, 1);
    let completeDelivery;
    const delivery = new Promise(resolve => {
      completeDelivery = resolve;
    });
    let reachedDelivery;
    const deliveryStarted = new Promise(resolve => {
      reachedDelivery = resolve;
    });
    const pending = directChat(
      config,
      { apiKey: 'test' },
      '我叫什么',
      new AbortController().signal,
      async () => {},
      context,
      async () => {
        reachedDelivery();
        await delivery;
      }
    );
    await deliveryStarted;
    assert.equal(saved.length, 1);
    completeDelivery();
    await pending;
    assert.equal(saved.length, 2);
  } finally {
    globalThis.fetch = oldFetch;
    SessionRegistry.prototype.privateHistory = oldRead;
    SessionRegistry.prototype.appendPrivateTurn = oldAppend;
  }
});
