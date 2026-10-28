import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResultCode, getConfig } from 'alemonjs';
import { normalizeOneBotEvent } from '../lib/onebot/events.js';
import { OneBotActions } from '../lib/onebot/actions.js';
import { resolveCurrentImages } from '../lib/media/onebot-images.js';
import { getMediaConfig } from '../lib/media/config.js';
import { prepareNativeMedia } from '../lib/media/providers.js';
import { runDSHChat } from '../lib/response/dsh/chat.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const source = () => normalizeOneBotEvent({ post_type: 'message', message_type: 'private', self_id: 900, user_id: 100, message_id: 50,
  message: [{ type: 'image', data: { file: 'a.png' } }, { type: 'image', data: { file: 'b.png', sub_type: 1 } }] }, '900', () => true);

test('gateway resolves each current image and real multimodal input receives its bytes', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const calls = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (action, args) => {
    calls.push({ action, args });
    return { file: `base64://${png.toString('base64')}` };
  } }, () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  await runtimeScope.run(runtime, async () => {
    getConfig().saveValue({ 'alemonjs-agent-link': { budget: { enabled: false } } });
    const event = source();
    const media = await resolveCurrentImages(event);
    const blocks = await prepareNativeMedia(media, '看看', getMediaConfig(), new AbortController().signal, async () => assert.fail('must use resolved bytes'));
    assert.equal(blocks.filter(item => item.type === 'image').length, 2);
    assert.equal(blocks[1].data, png.toString('base64'));
    assert.equal(media[1].Type, 'sticker');
    assert.deepEqual(calls, [{ action: 'get_image', args: { file: 'a.png' } }, { action: 'get_image', args: { file: 'b.png' } }]);
    assert.equal(event.MessageMedia[0]._onebotImage, undefined);
  });
});

test('image cache is scoped, and bad or unrelated image responses are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onebot-images-'));
  try {
    const cache = join(root, 'cache');
    await mkdir(cache);
    const inside = join(cache, 'pic.png');
    const outside = join(root, 'secret.png');
    await writeFile(inside, png);
    await writeFile(outside, png);
    await symlink(outside, join(cache, 'escape.png'));
    let result = { file: inside };
    const adapter = new OneBotActions({ config: { selfId: '900', imageDirectory: cache }, call: async () => result },
      () => ({ owner: () => true, groups: [], disabled: [] }));
    const api = (index, event = source()) => adapter.api({ payload: { event, key: 'agentLink.resolveCurrentImage', params: [{ index }] } });
    assert.equal((await api(0))[0].data.base64, png.toString('base64'));
    result = { file: join(cache, 'escape.png') };
    assert.notEqual((await api(0))[0].code, ResultCode.Ok);
    result = { base64: Buffer.from('not an image').toString('base64') };
    assert.notEqual((await api(0))[0].code, ResultCode.Ok);
    assert.notEqual((await api(3))[0].code, ResultCode.Ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed source URL falls back to get_image while a good URL avoids another gateway request', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const calls = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (action, args) => {
    calls.push({ action, args });
    return { base64: png.toString('base64') };
  } }, () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  await runtimeScope.run(runtime, async () => {
    getConfig().saveValue({ 'alemonjs-agent-link': { budget: { enabled: false } } });
    const event = source();
    event.MessageMedia[0].Url = 'https://cdn.test/broken';
    event.MessageMedia[1].Url = 'https://cdn.test/working';
    const media = await resolveCurrentImages(event);
    assert.deepEqual(calls, []);
    const blocks = await prepareNativeMedia(media, '看看', getMediaConfig(), new AbortController().signal, async url => {
      if (url.endsWith('/broken')) throw new Error('expired');
      return png;
    });
    assert.equal(blocks.filter(item => item.type === 'image').length, 2);
    assert.deepEqual(calls, [{ action: 'get_image', args: { file: 'a.png' } }]);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(prepareNativeMedia(media, '', getMediaConfig(), cancelled.signal));
    assert.equal(calls.length, 1);
  });
});

test('image fallback retains each group source message and attachment index', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const seen = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (_action, args) => ({ base64: png.toString('base64'), args }) },
    () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => {
    seen.push({ messageId: frame.payload.event.MessageId, file: frame.payload.event.MessageMedia[frame.payload.params[0].index]._onebotImageFile });
    return adapter.api(frame);
  } };
  await runtimeScope.run(runtime, async () => {
    getConfig().saveValue({ 'alemonjs-agent-link': { budget: { enabled: false } } });
    const group = (id, file) => ({ ...source(), IsPrivate: false, ChannelId: '200', MessageId: id,
      MessageMedia: [{ Type: 'image', Url: 'https://cdn.test/expired', _onebotImageFile: file }] });
    const first = await resolveCurrentImages(group('51', 'first.png'));
    const second = await resolveCurrentImages(group('52', 'second.png'));
    await prepareNativeMedia([...first, ...second], '', getMediaConfig(), new AbortController().signal, async () => { throw new Error('expired'); });
    assert.deepEqual(seen, [{ messageId: '51', file: 'first.png' }, { messageId: '52', file: 'second.png' }]);
  });
});

test('private chat sends resolved OneBot images in the actual model request', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'onebot-image-chat-'));
  const previousFetch = globalThis.fetch;
  const previousConfig = globalThis.__config;
  const settings = { apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') };
  globalThis.__config = { value: { 'alemonjs-agent-link': settings } };
  const config = getDSHConfig();
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (action) => {
    if (action !== 'get_image') throw new Error('unsupported');
    return { base64: png.toString('base64') };
  } }, () => ({ owner: () => true, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  let modelCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const messages = JSON.parse(init.body).messages;
    const contents = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    assert.equal(contents.filter(part => part.type === 'image_url').length, 2);
    assert.ok(contents.some(part => part.image_url?.url?.includes(png.toString('base64'))));
    modelCalls++;
    return Response.json({ choices: [{ message: { content: '看到图片了。' } }] });
  };
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': settings });
      let result;
      await runDSHChat(source(), '看看', { transport: { message: { send: async () => [{ code: ResultCode.Ok, data: { id: '99' } }] },
        media: { send: async () => assert.fail('unexpected media send') } }, onOutcome: value => { result = value; } });
      assert.equal(result?.delivered, true);
      assert.equal(modelCalls, 1);
    });
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.fetch = previousFetch;
    globalThis.__config = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});
