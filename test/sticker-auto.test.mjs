import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getMediaConfig } from '../lib/media/config.js';
import { AutoStickerCollector } from '../lib/media/sticker-auto.js';
import { labelSticker, assessSticker } from '../lib/media/providers.js';
import { normalizeOneBotEvent } from '../lib/onebot/events.js';
import { collectSticker, listStickers } from '../lib/media/stickers.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OneBotActions } from '../lib/onebot/actions.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const event = changes => ({
  Platform: 'onebot',
  ChannelId: '200',
  UserId: '300',
  MessageId: '1',
  IsPrivate: false,
  IsBot: false,
  MessageMedia: [{ Type: 'sticker', Url: 'https://cdn.test/a' }],
  ...changes
});
const options = { autoCollect: true, autoGroups: ['onebot:200'], autoOwnerPrivate: true, autoLabel: true, autoMaxPerHour: 20, autoDetect: false };
const waitFor = async fn => {
  for (let i = 0; i < 100 && !fn(); i++) await sleep(5);
  assert.ok(fn(), 'background collection did not finish');
};

test('OneBot distinguishes explicit sticker segments from ordinary images', () => {
  const raw = {
    post_type: 'message',
    message_type: 'group',
    self_id: 900,
    group_id: 200,
    user_id: 300,
    message_id: 123,
    sender: {},
    message: [
      { type: 'image', data: { url: 'https://cdn.test/photo' } },
      { type: 'image', data: { url: 'https://cdn.test/sticker', sub_type: 1 } },
      { type: 'mface', data: { url: 'https://cdn.test/mface' } }
    ]
  };
  const result = normalizeOneBotEvent(raw, '900', () => false);
  assert.deepEqual(
    result.MessageMedia.map(item => item.Type),
    ['image', 'sticker', 'sticker']
  );
});

test('automatic collection is opt-in, scoped, deduplicated and uses caption results', async () => {
  let config = getDSHConfig({ modules: { settings: { stickers: options } } });
  const media = { ...getMediaConfig({}), stickerRoot: '/configured', vision: { baseUrl: 'https://vision.test/v1', apiKey: 'test', model: 'test' } };
  const saved = [];
  let downloads = 0;
  let labels = 0;
  const collector = new AutoStickerCollector({
    config: () => config,
    media: () => media,
    download: async () => {
      downloads++;
      return png;
    },
    assess: async data => {
      labels++;
      assert.deepEqual(data, png);
      return { sticker: true, suitable: true, name: '猫猫', tags: ['开心'], confidence: 0.9 };
    },
    collect: async (_config, data, tags, _signal, meta) => {
      saved.push({ data, tags, meta });
      return { id: 'one', existing: false };
    },
    failed: () => assert.fail('unexpected failure')
  });
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
  assert.equal(saved[0].meta.name, '猫猫');
  assert.equal(saved[0].meta.from, 'auto');
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
  const started = new Promise(resolve => {
    start = resolve;
  });
  let saved = 0;
  const collector = new AutoStickerCollector({
    config: () => config,
    media: () => media,
    download: async (_url, _config, signal) => {
      start();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted();
      return png;
    },
    assess: async () => ({ sticker: true, suitable: true, name: '', tags: [], confidence: 1 }),
    collect: async () => {
      saved++;
      return { id: 'one', existing: false };
    },
    failed: () => assert.fail('reset is not an error')
  });
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
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let saved = 0;
  const collector = new AutoStickerCollector({
    config: () => config,
    media: () => media,
    download: async () => {
      await gate;
      return png;
    },
    assess: async () => ({ sticker: true, suitable: true, name: '', tags: [], confidence: 1 }),
    collect: async () => {
      saved++;
      return { id: 'one', existing: false };
    },
    failed: () => assert.fail('unexpected failure')
  });
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
  const collector = new AutoStickerCollector({
    config: () => config,
    media: () => media,
    download: async () => png,
    assess: async () => ({ sticker: true, suitable: true, name: '', tags: [], confidence: 1 }),
    collect: async (...args) => {
      const result = await collectSticker(...args);
      done = true;
      return result;
    },
    failed: () => assert.fail('unexpected failure')
  });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    const raw = {
      post_type: 'message',
      message_type: 'group',
      self_id: 900,
      group_id: 200,
      user_id: 300,
      message_id: 123,
      sender: {},
      message: [{ type: 'image', data: { url: 'https://cdn.test/sticker', sub_type: 1 } }]
    };
    assert.equal(collector.enqueue(normalizeOneBotEvent(raw, '900', () => false)), 1);
    await waitFor(() => done);
    assert.deepEqual(
      (await listStickers(media)).map(item => item.tags),
      [['表情']]
    );
  } finally {
    collector.reset();
    await rm(root, { recursive: true, force: true });
  }
});

test('file-only and expired-URL marked stickers use their own OneBot image indices and enter the manifest', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'sticker-auto-onebot-'));
  const config = getDSHConfig({ modules: { settings: { stickers: { ...options, autoLabel: false } } } });
  const media = getMediaConfig({ media: { stickerRoot: root } });
  const calls = [];
  const adapter = new OneBotActions(
    {
      config: { selfId: '900' },
      call: async (action, args) => {
        calls.push({ action, args });
        const data = args.file === 'a.png' ? png : Buffer.concat([png, Buffer.from([2])]);
        return { base64: data.toString('base64') };
      }
    },
    () => ({ owner: () => false, groups: [], disabled: [] })
  );
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  let done = 0;
  const collector = new AutoStickerCollector({
    config: () => config,
    media: () => media,
    download: async () => {
      throw new Error('expired');
    },
    assess: async () => ({ sticker: true, suitable: true, name: '', tags: [], confidence: 1 }),
    collect: async (...args) => {
      const result = await collectSticker(...args);
      done++;
      return result;
    },
    failed: () => assert.fail('unexpected failure')
  });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    await runtimeScope.run(runtime, async () => {
      const incoming = normalizeOneBotEvent(
        {
          post_type: 'message',
          message_type: 'group',
          self_id: 900,
          group_id: 200,
          user_id: 300,
          message_id: 123,
          sender: {},
          message: [
            { type: 'image', data: { file: 'photo.png' } },
            { type: 'mface', data: { file: 'a.png' } },
            { type: 'image', data: { file: 'b.png', sub_type: 1, url: 'https://cdn.test/expired' } }
          ]
        },
        '900',
        () => false
      );
      assert.equal(collector.enqueue(incoming), 2);
      await waitFor(() => done === 2);
      assert.deepEqual(calls, [
        { action: 'get_image', args: { file: 'a.png' } },
        { action: 'get_image', args: { file: 'b.png' } }
      ]);
      assert.equal((await listStickers(media)).length, 2);
    });
  } finally {
    collector.reset();
    await rm(root, { recursive: true, force: true });
  }
});

test('reset during a OneBot image lookup prevents a stale automatic collection', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const config = getDSHConfig({ modules: { settings: { stickers: { ...options, autoLabel: false } } } });
  const media = { ...getMediaConfig({}), stickerRoot: '/configured' };
  let start, release;
  const started = new Promise(resolve => {
    start = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let saved = 0;
  const adapter = new OneBotActions(
    {
      config: { selfId: '900' },
      call: async () => {
        start();
        await gate;
        return { base64: png.toString('base64') };
      }
    },
    () => ({ owner: () => false, groups: [], disabled: [] })
  );
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  const collector = new AutoStickerCollector({
    config: () => config,
    media: () => media,
    download: async () => assert.fail('unexpected download'),
    assess: async () => ({ sticker: true, suitable: true, name: '', tags: [], confidence: 1 }),
    collect: async () => {
      saved++;
      return { id: 'one', existing: false };
    },
    failed: () => assert.fail('reset is not an error')
  });
  await runtimeScope.run(runtime, async () => {
    const incoming = normalizeOneBotEvent(
      {
        post_type: 'message',
        message_type: 'group',
        self_id: 900,
        group_id: 200,
        user_id: 300,
        message_id: 123,
        sender: {},
        message: [{ type: 'mface', data: { file: 'a.png' } }]
      },
      '900',
      () => false
    );
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
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__config = oldConfig;
  }
});

const microPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const widePng = Buffer.alloc(33);
widePng.set([137, 80, 78, 71, 13, 10, 26, 10]);
widePng.write('IHDR', 12);
widePng.writeUInt32BE(1000, 16);
widePng.writeUInt32BE(100, 20);
const imageEvent = id => event({ MessageId: id, MessageMedia: [{ Type: 'image', Url: `https://cdn.test/${id}` }] });

test('ordinary images are silently assessed and only suitable stickers are collected', async () => {
  const config = getDSHConfig({ modules: { settings: { stickers: { ...options, autoDetect: true, autoLabel: false } } } });
  const media = { ...getMediaConfig({}), stickerRoot: '/configured', vision: { baseUrl: 'https://vision.test/v1', apiKey: 'test', model: 'test' } };
  const results = [
    { sticker: true, suitable: true, name: '猫猫', tags: ['开心'], confidence: 0.9 },
    { sticker: false, suitable: true, name: '', tags: [], confidence: 0.2 },
    { sticker: true, suitable: false, name: '', tags: [], confidence: 0.9 },
    { sticker: true, suitable: true, name: '', tags: [], confidence: 0.4 }
  ];
  let assessed = 0;
  const saved = [];
  const collector = new AutoStickerCollector({
    config: () => config,
    media: () => media,
    download: async url => (url.endsWith('/wide') ? widePng : microPng),
    assess: async data => {
      assert.deepEqual(data, microPng);
      return results[assessed++];
    },
    collect: async (_config, _data, tags, _signal, meta) => {
      saved.push({ tags, meta });
      return { id: 'one', existing: false };
    },
    failed: () => assert.fail('unexpected failure')
  });
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(collector.enqueue(imageEvent(id)), 1);
  await waitFor(() => saved.length === 1 && assessed === 4);
  assert.deepEqual(saved[0].tags, ['开心']);
  assert.equal(saved[0].meta.name, '猫猫');
  assert.equal(saved[0].meta.from, 'auto');
  assert.equal(saved[0].meta.confidence, 0.9);
  assert.equal(collector.enqueue(imageEvent('wide')), 1);
  await sleep(30);
  assert.equal(assessed, 4);
  assert.equal(saved.length, 1);
  const noVision = new AutoStickerCollector({
    config: () => config,
    media: () => ({ ...media, vision: undefined }),
    download: async () => microPng,
    assess: async () => assert.fail('assessment needs vision'),
    collect: async () => assert.fail('nothing should be collected'),
    failed: () => assert.fail('unexpected failure')
  });
  assert.equal(noVision.enqueue(imageEvent('e')), 0);
  collector.reset();
});

test('vision assessment validates JSON, sanitizes tags and skips GIF', async () => {
  const oldFetch = globalThis.fetch;
  const oldConfig = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
  const media = getMediaConfig({ media: { vision: { baseUrl: 'https://vision.test/v1', apiKey: 'test', model: 'test' } } });
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(init.body);
    assert.equal(body.messages[1].content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
    return Response.json({
      choices: [{ message: { content: '```json\n{"sticker":true,"suitable":true,"name":" 猫猫 ","tags":["开心","开心","晚安"],"confidence":0.8}\n```' } }]
    });
  };
  try {
    assert.deepEqual(await assessSticker(png, media, new AbortController().signal), {
      sticker: true,
      suitable: true,
      kind: 'sticker',
      category: '未分类',
      name: '猫猫',
      tags: ['开心', '晚安'],
      confidence: 0.8
    });
    assert.deepEqual(await assessSticker(Buffer.from('GIF89a'), media, new AbortController().signal), {
      sticker: false,
      suitable: false,
      kind: 'other',
      category: '',
      name: '',
      tags: [],
      confidence: 0
    });
    assert.equal(requests, 1);
    assert.deepEqual(await assessSticker(png, getMediaConfig({}), new AbortController().signal), {
      sticker: false,
      suitable: false,
      kind: 'other',
      category: '',
      name: '',
      tags: [],
      confidence: 0
    });
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"sticker":"yes"}' } }] });
    await assert.rejects(assessSticker(png, media, new AbortController().signal), /有效结果/);
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'no' } }] });
    await assert.rejects(assessSticker(png, media, new AbortController().signal), /有效结果/);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.__config = oldConfig;
  }
});

test('optional QQ sync writes a newly collected sticker back exactly once', async () => {
  const config = getDSHConfig({ modules: { settings: { stickers: { ...options, autoLabel: false, autoQQSync: true } } } });
  const media = { ...getMediaConfig({}), stickerRoot: '/configured' };
  const synced = [];
  const emoji = [];
  const collector = new AutoStickerCollector({
    config: () => config,
    media: () => media,
    download: async () => png,
    assess: async () => ({ sticker: true, suitable: true, name: '', tags: [], confidence: 1 }),
    collect: async () => ({ id: 'one', existing: false, item: { id: 'one', file: 'managed/a.png', tags: ['表情'] } }),
    favorite: async (event, data, name) => {
      synced.push({ event, data, name });
      return 'e_1';
    },
    setEmoji: async (_config, id, emojiId) => {
      emoji.push({ id, emojiId });
      return true;
    },
    failed: () => assert.fail('unexpected failure')
  });
  assert.equal(collector.enqueue(event({ MessageId: 'sync-1' })), 1);
  await waitFor(() => emoji.length === 1);
  assert.equal(synced.length, 1);
  assert.equal(synced[0].event.Platform, 'onebot');
  assert.deepEqual(synced[0].data, png);
  assert.deepEqual(emoji[0], { id: 'one', emojiId: 'e_1' });
  collector.reset();

  const duplicate = new AutoStickerCollector({
    config: () => config,
    media: () => media,
    download: async () => png,
    assess: async () => ({ sticker: true, suitable: true, name: '', tags: [], confidence: 1 }),
    collect: async () => ({ id: 'one', existing: true, item: { id: 'one', file: 'managed/a.png', tags: ['表情'] } }),
    favorite: async () => assert.fail('duplicates must not be written to QQ again'),
    setEmoji: async () => assert.fail('duplicates must not update emoji ids'),
    failed: () => assert.fail('unexpected failure')
  });
  assert.equal(duplicate.enqueue(event({ MessageId: 'sync-2' })), 1);
  await sleep(30);
  duplicate.reset();
});
