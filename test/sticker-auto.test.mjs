import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getMediaConfig } from '../lib/media/config.js';
import { AutoStickerCollector } from '../lib/media/sticker-auto.js';
import { labelSticker } from '../lib/media/providers.js';
import { normalizeOneBotEvent } from '../lib/onebot/events.js';
import { collectSticker, listStickers } from '../lib/media/stickers.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OneBotActions } from '../lib/onebot/actions.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const event = changes => ({ Platform: 'onebot', ChannelId: '200', UserId: '300', MessageId: '1', IsPrivate: false, IsBot: false,
  MessageMedia: [{ Type: 'sticker', Url: 'https://cdn.test/a' }], ...changes });
const options = { autoCollect: true, autoGroups: ['onebot:200'], autoOwnerPrivate: true, autoLabel: true, autoMaxPerHour: 20 };
const waitFor = async fn => { for (let i = 0; i < 100 && !fn(); i++) await sleep(5); assert.ok(fn(), 'background collection did not finish'); };

test('OneBot distinguishes explicit sticker segments from ordinary images', () => {
  const raw = { post_type: 'message', message_type: 'group', self_id: 900, group_id: 200, user_id: 300, message_id: 123,
    sender: {}, message: [
      { type: 'image', data: { url: 'https://cdn.test/photo' } },
      { type: 'image', data: { url: 'https://cdn.test/sticker', sub_type: 1 } },
      { type: 'mface', data: { url: 'https://cdn.test/mface' } }
    ] };
  const result = normalizeOneBotEvent(raw, '900', () => false);
  assert.deepEqual(result.MessageMedia.map(item => item.Type), ['image', 'sticker', 'sticker']);
});

test('automatic collection is opt-in, scoped, deduplicated and uses caption results', async () => {
  let config = getDSHConfig({ modules: { settings: { stickers: options } } });
  const media = { ...getMediaConfig({}), stickerRoot: '/configured', vision: { baseUrl: 'https://vision.test/v1', apiKey: 'test', model: 'test' } };
  const saved = [];
  let downloads = 0;
  let labels = 0;
  const collector = new AutoStickerCollector({ config: () => config, media: () => media,
    download: async () => { downloads++; return png; }, label: async data => { labels++; assert.deepEqual(data, png); return ['开心']; },
    collect: async (_config, data, tags) => { saved.push({ data, tags }); return { id: 'one', existing: false }; }, failed: () => assert.fail('unexpected failure') });
  assert.equal(collector.enqueue(event({ ChannelId: '201' })), 0);
  assert.equal(collector.enqueue(event({ IsBot: true })), 0);
  assert.equal(collector.enqueue(event({ MessageMedia: [{ Type: 'image', Url: 'https://cdn.test/p' }] })), 0);
  assert.equal(collector.enqueue(event({ IsPrivate: true, IsMaster: false })), 0);
  assert.equal(collector.enqueue(event({})), 1);
  assert.equal(collector.enqueue(event({})), 0);
  await waitFor(() => saved.length === 1);
  assert.equal(downloads, 1);
  assert.equal(labels, 1);
  assert.deepEqual(saved[0].tags, ['开心']);
  config = getDSHConfig({ modules: { settings: { stickers: { ...options, autoLabel: false } } } });
  assert.equal(collector.enqueue(event({ MessageId: '2' })), 1);
  await waitFor(() => saved.length === 2);
  assert.deepEqual(saved[1].tags, ['表情']);
  assert.equal(labels, 1);
  collector.reset();
});

test('configuration reset cancels active capture and blocks stale writes', async () => {
  const config = getDSHConfig({ modules: { settings: { stickers: options } } });
  const media = { ...getMediaConfig({}), stickerRoot: '/configured' };
  let start;
  const started = new Promise(resolve => { start = resolve; });
  let saved = 0;
  const collector = new AutoStickerCollector({ config: () => config, media: () => media,
    download: async (_url, _config, signal) => { start(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); return png; },
    label: async () => [], collect: async () => { saved++; return { id: 'one', existing: false }; }, failed: () => assert.fail('reset is not an error') });
  collector.enqueue(event({}));
  await started;
  collector.reset();
  await sleep(20);
  assert.equal(saved, 0);
});

test('hourly limit and queue capacity bound automatic attachment work', async () => {
  const config = getDSHConfig({ modules: { settings: { stickers: { ...options, autoLabel: false, autoMaxPerHour: 2 } } } });
  const media = { ...getMediaConfig({}), stickerRoot: '/configured' };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let saved = 0;
  const collector = new AutoStickerCollector({ config: () => config, media: () => media,
    download: async () => { await gate; return png; }, label: async () => [],
    collect: async () => { saved++; return { id: 'one', existing: false }; }, failed: () => assert.fail('unexpected failure') });
  assert.equal(collector.enqueue(event({ MessageId: 'a' })), 1);
  assert.equal(collector.enqueue(event({ MessageId: 'b' })), 1);
  assert.equal(collector.enqueue(event({ MessageId: 'c' })), 0);
  release();
  await waitFor(() => saved === 2);
  collector.reset();
});

test('a normalized marked sticker reaches the real manifest through the background queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-auto-manifest-'));
  const config = getDSHConfig({ modules: { settings: { stickers: { ...options, autoLabel: false } } } });
  const media = getMediaConfig({ media: { stickerRoot: root } });
  let done = false;
  const collector = new AutoStickerCollector({ config: () => config, media: () => media,
    download: async () => png, label: async () => [], collect: async (...args) => { const result = await collectSticker(...args); done = true; return result; },
    failed: () => assert.fail('unexpected failure') });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    const raw = { post_type: 'message', message_type: 'group', self_id: 900, group_id: 200, user_id: 300, message_id: 123,
      sender: {}, message: [{ type: 'image', data: { url: 'https://cdn.test/sticker', sub_type: 1 } }] };
    assert.equal(collector.enqueue(normalizeOneBotEvent(raw, '900', () => false)), 1);
    await waitFor(() => done);
    assert.deepEqual((await listStickers(media)).map(item => item.tags), [['表情']]);
  } finally { collector.reset(); await rm(root, { recursive: true, force: true }); }
});

test('file-only and expired-URL marked stickers use their own OneBot image indices and enter the manifest', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'sticker-auto-onebot-'));
  const config = getDSHConfig({ modules: { settings: { stickers: { ...options, autoLabel: false } } } });
  const media = getMediaConfig({ media: { stickerRoot: root } });
  const calls = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (action, args) => {
    calls.push({ action, args });
    const data = args.file === 'a.png' ? png : Buffer.concat([png, Buffer.from([2])]);
    return { base64: data.toString('base64') };
  } }, () => ({ owner: () => false, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  let done = 0;
  const collector = new AutoStickerCollector({ config: () => config, media: () => media,
    download: async () => { throw new Error('expired'); }, label: async () => [],
    collect: async (...args) => { const result = await collectSticker(...args); done++; return result; }, failed: () => assert.fail('unexpected failure') });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    await runtimeScope.run(runtime, async () => {
      const incoming = normalizeOneBotEvent({ post_type: 'message', message_type: 'group', self_id: 900, group_id: 200, user_id: 300, message_id: 123,
        sender: {}, message: [{ type: 'image', data: { file: 'photo.png' } }, { type: 'mface', data: { file: 'a.png' } },
          { type: 'image', data: { file: 'b.png', sub_type: 1, url: 'https://cdn.test/expired' } }] }, '900', () => false);
      assert.equal(collector.enqueue(incoming), 2);
      await waitFor(() => done === 2);
      assert.deepEqual(calls, [{ action: 'get_image', args: { file: 'a.png' } }, { action: 'get_image', args: { file: 'b.png' } }]);
      assert.equal((await listStickers(media)).length, 2);
    });
  } finally { collector.reset(); await rm(root, { recursive: true, force: true }); }
});

test('reset during a OneBot image lookup prevents a stale automatic collection', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const config = getDSHConfig({ modules: { settings: { stickers: { ...options, autoLabel: false } } } });
  const media = { ...getMediaConfig({}), stickerRoot: '/configured' };
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let saved = 0;
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async () => { start(); await gate; return { base64: png.toString('base64') }; } },
    () => ({ owner: () => false, groups: [], disabled: [] }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  const collector = new AutoStickerCollector({ config: () => config, media: () => media, download: async () => assert.fail('unexpected download'),
    label: async () => [], collect: async () => { saved++; return { id: 'one', existing: false }; }, failed: () => assert.fail('reset is not an error') });
  await runtimeScope.run(runtime, async () => {
    const incoming = normalizeOneBotEvent({ post_type: 'message', message_type: 'group', self_id: 900, group_id: 200, user_id: 300, message_id: 123,
      sender: {}, message: [{ type: 'mface', data: { file: 'a.png' } }] }, '900', () => false);
    assert.equal(collector.enqueue(incoming), 1);
    await started;
    collector.reset();
    release();
    await sleep(20);
    assert.equal(saved, 0);
  });
});

test('label requests use the exact image, validate tags and skip GIF', async () => {
  const oldFetch = globalThis.fetch;
  const oldConfig = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
  const media = getMediaConfig({ media: { vision: { baseUrl: 'https://vision.test/v1', apiKey: 'test', model: 'test' } } });
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(init.body);
    assert.equal(body.messages[1].content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
    return Response.json({ choices: [{ message: { content: '["开心","开心","鲸鱼"]' } }] });
  };
  try {
    assert.deepEqual(await labelSticker(png, media, new AbortController().signal), ['开心', '鲸鱼']);
    assert.deepEqual(await labelSticker(Buffer.from('GIF89a'), media, new AbortController().signal), []);
    assert.equal(requests, 1);
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"invalid":true}' } }] });
    await assert.rejects(labelSticker(png, media, new AbortController().signal), /有效标签/);
  } finally { globalThis.fetch = oldFetch; globalThis.__config = oldConfig; }
});
