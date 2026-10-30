import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { getCredentialPool } from '../lib/credentials/pool.js';
import { getMediaConfig } from '../lib/media/config.js';
import { assessSticker, labelSticker } from '../lib/media/providers.js';
import { AutoStickerCollector } from '../lib/media/sticker-auto.js';
import { collectSticker, listStickers } from '../lib/media/stickers.js';
import { importStickerUrls } from '../lib/media/sticker-import.js';

let previous, originalFetch, root, media, png;
const signal = () => new AbortController().signal;
const assessment = { kind: 'sticker', sticker: true, suitable: true, name: '开心', category: '开心', tags: ['开心'], confidence: 0.95 };
const result = (content, finish_reason = 'stop') =>
  Response.json({
    choices: [{ message: { content: JSON.stringify(content) }, finish_reason }],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 }
  });
const state = () => getCredentialPool(getDSHConfig()).status.find(row => row.id === 'vision');
const until = async check => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('collector did not finish');
};
beforeEach(async () => {
  previous = globalThis.__config;
  originalFetch = globalThis.fetch;
  root = await mkdtemp(join(tmpdir(), 'sticker-vision-pool-'));
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        budget: { enabled: false },
        modelPool: {
          probeIntervalSeconds: 0,
          endpoints: [
            {
              id: 'vision',
              model: 'vision-model',
              baseUrl: 'https://vision.example/v1',
              apiKey: 'vision-fixture-secret',
              capabilities: ['vision'],
              maxConcurrent: 1
            }
          ]
        },
        modules: { settings: { stickers: { autoQQSync: false } } }
      }
    }
  };
  media = getMediaConfig({ media: { stickerRoot: join(root, 'stickers') } });
  png = await sharp({ create: { width: 128, height: 128, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
});
afterEach(async () => {
  getCredentialPool({});
  globalThis.__config = previous;
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
});

test('sticker assessment and tags reuse only the vision pool with bounded output and real usage reporting', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://vision.example/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer vision-fixture-secret');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'vision-model');
    assert.equal(body.max_tokens, 600);
    return result(calls === 1 ? assessment : ['开心']);
  };
  assert.equal((await assessSticker(png, media, signal())).kind, 'sticker');
  assert.deepEqual(await labelSticker(png, media, signal()), ['开心']);
  assert.equal(state().active, 0);
  assert.equal(state().tokens, 260);
  assert.equal(state().purposeStatistics.vision.success, 2);
});

test('ordinary images from non-owners can pass pool assessment and enter the real sticker store', async () => {
  let calls = 0,
    collected = 0;
  globalThis.fetch = async () => {
    calls++;
    return result(assessment);
  };
  const collector = new AutoStickerCollector({
    config: getDSHConfig,
    media: () => media,
    download: async () => png,
    assess: assessSticker,
    collect: async (...args) => {
      const stored = await collectSticker(...args);
      collected++;
      return stored;
    },
    failed: () => assert.fail('unexpected collection failure')
  });
  try {
    assert.equal(
      collector.enqueue({
        Platform: 'onebot',
        ChannelId: 'group',
        UserId: 'member',
        IsMaster: false,
        MessageId: 'meme-1',
        MessageMedia: [{ Type: 'image', Url: 'https://cdn.example/synthetic.png' }]
      }),
      1
    );
    await until(() => collected === 1);
    const stored = await listStickers(media);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, '开心');
    assert.ok(stored[0].tags.includes('开心'));
    assert.equal(calls, 1);
    assert.equal(state().active, 0);
  } finally {
    collector.reset();
  }
});

test('no vision capability means no ordinary-image download or external classification', async () => {
  globalThis.__config.value['alemonjs-agent-link'].modelPool.endpoints[0].capabilities = ['chat'];
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('must not request');
  };
  const collector = new AutoStickerCollector({
    config: getDSHConfig,
    media: () => media,
    download: async () => {
      throw new Error('must not download');
    },
    assess: assessSticker,
    collect: collectSticker,
    failed: () => assert.fail('unexpected failure')
  });
  assert.equal(
    collector.enqueue({
      Platform: 'onebot',
      ChannelId: 'group',
      UserId: 'member',
      MessageId: '1',
      MessageMedia: [{ Type: 'image', Url: 'https://cdn.example/photo.png' }]
    }),
    0
  );
  assert.equal((await assessSticker(png, media, signal())).suitable, false);
  assert.deepEqual(await labelSticker(png, media, signal()), []);
  assert.equal(requests, 0);
});

test('truncated or malformed pool assessment never becomes an approval and releases capacity', async () => {
  globalThis.fetch = async () => result(assessment, 'length');
  await assert.rejects(assessSticker(png, media, signal()), /截断/);
  assert.equal(state().active, 0);
  globalThis.fetch = async () => result({ sticker: 'yes', suitable: true });
  await assert.rejects(assessSticker(png, media, signal()), /未返回有效/);
  assert.equal(state().active, 0);
  assert.equal(state().failedCalls, 2);
});

test('explicit sticker vision stays preferred and unsupported GIFs do not invoke pooled vision', async () => {
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://explicit.example/chat/completions');
    return result(assessment);
  };
  await assessSticker(png, { ...media, vision: { baseUrl: 'https://explicit.example', apiKey: 'fixture', model: 'explicit' } }, signal());
  assert.equal(state().totalCalls, 0);
  globalThis.fetch = async () => assert.fail('GIF must not invoke vision');
  const gif = Buffer.from('GIF89a');
  assert.equal((await assessSticker(gif, media, signal())).suitable, false);
  assert.deepEqual(await labelSticker(gif, media, signal()), []);
});

test('explicit favorite import can obtain pool-generated names and tags without independent vision config', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return result(assessment);
  };
  const imported = await importStickerUrls(media, ['https://cdn.example/curated.png'], signal(), async () => png);
  assert.equal(imported.added, 1);
  assert.equal(requests, 1);
  const stored = await listStickers(media);
  assert.equal(stored[0].name, '开心');
  assert.ok(stored[0].tags.includes('开心'));
  assert.equal(state().active, 0);
});
