import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultCode, getConfig } from 'alemonjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OneBotActions } from '../lib/onebot/actions.js';
import { MessageReferences } from '../lib/social/references.js';
import { prepareNativeMedia } from '../lib/media/providers.js';
import { getMediaConfig } from '../lib/media/config.js';
import { runDSHChat } from '../lib/response/dsh/chat.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { resolveCurrentImages } from '../lib/media/onebot-images.js';

const event = { Platform: 'onebot', BotId: '900', IsPrivate: false, ChannelId: '200', UserId: '100', MessageId: '52', ReplyId: '51', MessageText: '接着说' };

test('unobserved quote is read through OneBot with author, image and bot attribution', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'quote-onebot-'));
  const calls = [];
  const connection = { config: { selfId: '900' }, call: async (action, args) => {
    calls.push({ action, args });
    return { message_id: 51, message_type: 'group', group_id: 200, time: 1700000000, sender: { user_id: 900, nickname: '肥鱼' },
      message: [{ type: 'text', data: { text: '之前的回答' } }, { type: 'image', data: { url: 'https://example.com/p.png' } }] };
  } };
  const adapter = new OneBotActions(connection, () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': { apiKey: 'test', runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } });
      const result = await new MessageReferences().prepare(event);
      const quote = JSON.parse(result.context).quote;
      assert.equal(result.quotedBot, true);
      assert.equal(quote.senderId, '900');
      assert.equal(quote.text, '之前的回答');
      assert.equal(quote.attachments[0].inputAttachment, 1);
      assert.deepEqual(result.media, [{ Type: 'image', Url: 'https://example.com/p.png' }]);
      assert.deepEqual(calls, [{ action: 'get_msg', args: { message_id: 51 } }]);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('quote reader checks message binding and private or group scope', async () => {
  let message = { message_id: 51, message_type: 'group', group_id: 201, sender: { user_id: 900 }, message: [] };
  let calls = 0;
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async () => { calls++; return message; } },
    () => ({ owner: () => true, groups: [], disabled: [] }));
  const read = (source, id = '51') => adapter.api({ payload: { event: source, key: 'agentLink.readCurrentQuote', params: [{ messageId: id }] } });
  assert.notEqual((await read(event, '52'))[0].code, ResultCode.Ok);
  assert.equal(calls, 0);
  assert.notEqual((await read(event))[0].code, ResultCode.Ok);
  message = { message_id: 51, message_type: 'private', user_id: 900, target_id: 101, sender: { user_id: 900 }, message: [] };
  const privateEvent = { ...event, IsPrivate: true };
  assert.notEqual((await read(privateEvent))[0].code, ResultCode.Ok);
  message.target_id = 100;
  const outgoing = await read(privateEvent);
  assert.equal(outgoing[0].code, ResultCode.Ok);
  assert.equal(outgoing[0].data.isBot, true);
  message = { message_id: 51, message_type: 'private', user_id: 100, sender: { user_id: 100 }, message: [{ type: 'text', data: { text: '你好' } }] };
  assert.equal((await read(privateEvent))[0].code, ResultCode.Ok);
  message.message_id = 52;
  assert.notEqual((await read(privateEvent))[0].code, ResultCode.Ok);
});

test('unavailable, disabled, and already observed quotes do not invent or refetch content', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'quote-fallback-'));
  let calls = 0;
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async () => { calls++; throw new Error('unavailable'); } },
    () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  try {
    await runtimeScope.run(runtime, async () => {
      const base = { apiKey: 'test', runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') };
      getConfig().saveValue({ 'alemonjs-agent-link': base });
      const refs = new MessageReferences();
      const missing = JSON.parse((await refs.prepare(event)).context);
      assert.match(missing.unavailableQuote, /不可用/);
      assert.equal(calls, 1);
      await refs.capture({ ...event, MessageId: '51', ReplyId: undefined, MessageText: '本地已有原文' });
      const known = JSON.parse((await refs.prepare({ ...event, MessageId: '53' })).context);
      assert.equal(known.quote.text, '本地已有原文');
      assert.equal(calls, 1);
      getConfig().saveValue({ 'alemonjs-agent-link': { ...base, aiEnabled: false } });
      await new MessageReferences().prepare(event);
      assert.equal(calls, 1);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('quoted OneBot image without URL resolves only after checking its source and conversation', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'quote-image-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  let group = 200;
  let file = 'quoted.png';
  let url;
  const calls = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (action, args) => {
    calls.push({ action, args });
    if (action === 'get_msg') return { message_id: 51, message_type: 'group', group_id: group, sender: { user_id: 100 },
      message: [{ type: 'image', data: { file, url } }] };
    if (action === 'get_image') return { base64: png.toString('base64') };
    throw new Error('unexpected operation');
  } }, () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': { apiKey: 'test', runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } });
      const references = new MessageReferences();
      const prepared = await references.prepare(event);
      assert.equal(JSON.parse(prepared.context).quote.attachments[0].inputAttachment, 1);
      assert.equal(calls.length, 1);
      const media = await resolveCurrentImages({ ...event, MessageMedia: prepared.media });
      assert.equal(calls.length, 1);
      const input = await prepareNativeMedia(media, '解释引用图', getMediaConfig(), new AbortController().signal);
      assert.equal(input[1].data, png.toString('base64'));
      assert.deepEqual(calls.map(call => call.action), ['get_msg', 'get_msg', 'get_image']);
      url = 'https://cdn.test/expired';
      const expired = await new MessageReferences().prepare({ ...event, MessageId: '53' });
      const fallback = await prepareNativeMedia(expired.media, '', getMediaConfig(), new AbortController().signal, async () => { throw new Error('expired'); });
      assert.equal(fallback[1].data, png.toString('base64'));
      assert.equal(calls.filter(call => call.action === 'get_image').length, 2);
      group = 201;
      await assert.rejects(prepareNativeMedia(prepared.media, '', getMediaConfig(), new AbortController().signal));
      assert.equal(calls.filter(call => call.action === 'get_image').length, 2);
      group = 200;
      file = 'different.png';
      await assert.rejects(prepareNativeMedia(prepared.media, '', getMediaConfig(), new AbortController().signal));
      assert.equal(calls.filter(call => call.action === 'get_image').length, 2);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private reply to an unobserved image reaches the model with actual image bytes', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'quote-image-chat-'));
  const previousFetch = globalThis.fetch;
  const previousConfig = globalThis.__config;
  const settings = { apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') };
  globalThis.__config = { value: { 'alemonjs-agent-link': settings } };
  const config = getDSHConfig();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const calls = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async action => {
    calls.push(action);
    if (action === 'get_msg') return { message_id: 7101, message_type: 'private', user_id: 100, sender: { user_id: 100 }, message: [{ type: 'image', data: { file: 'quote.png' } }] };
    if (action === 'get_image') return { base64: png.toString('base64') };
    throw new Error('unexpected');
  } }, () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  let modelCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const messages = JSON.parse(init.body).messages;
    assert.ok(messages.flatMap(message => Array.isArray(message.content) ? message.content : []).some(part => part.image_url?.url?.includes(png.toString('base64'))));
    modelCalls++;
    return Response.json({ choices: [{ message: { content: '看到了。' } }] });
  };
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': settings });
      let outcome;
      await runDSHChat({ Platform: 'onebot', BotId: '900', IsPrivate: true, IsMaster: true, UserId: '100', UserKey: '100', MessageId: '7102', ReplyId: '7101', MessageText: '解释图片' },
        '解释图片', { transport: { message: { send: async () => [{ code: ResultCode.Ok, data: { id: '99' } }] }, media: { send: async () => assert.fail('unexpected') } }, onOutcome: value => { outcome = value; } });
      assert.equal(outcome?.delivered, true);
      assert.equal(modelCalls, 1);
      assert.deepEqual(calls, ['get_msg', 'get_msg', 'get_image']);
    });
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.fetch = previousFetch;
    globalThis.__config = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});
