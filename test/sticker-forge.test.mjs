import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageInfo } from '../lib/media/image-info.js';
import { renderSticker, stickerSvg } from '../lib/media/sticker-forge.js';
import { getMediaConfig } from '../lib/media/config.js';
import { listStickers } from '../lib/media/stickers.js';
import { stickerModule } from '../lib/modules/stickers.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { runModuleTurn } from '../lib/agent/turn.js';

const { Resvg } = createRequire(import.meta.url)('@resvg/resvg-js');
const source = () =>
  new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="32" height="32" fill="#ff0000"/><rect x="32" width="32" height="32" fill="#0000ff"/></svg>'
  )
    .render()
    .asPng();
const signal = () => new AbortController().signal;

test('image dimensions are read without decoding and reject unsupported input', () => {
  const png = imageInfo(source());

  assert.deepEqual(
    { mime: png?.mime, width: png?.width, height: png?.height, animated: png?.animated },
    {
      mime: 'image/png',
      width: 64,
      height: 32,
      animated: false
    }
  );
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64'
  );
  assert.deepEqual([imageInfo(jpeg)?.width, imageInfo(jpeg)?.height], [1, 1]);
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  assert.deepEqual([imageInfo(gif)?.width, imageInfo(gif)?.height], [1, 1]);
  const webp = Buffer.alloc(40);
  webp.write('RIFF', 0);
  webp.write('WEBP', 8);
  webp.write('VP8X', 12);
  webp.writeUIntLE(99, 24, 3);
  webp.writeUIntLE(49, 27, 3);
  assert.deepEqual([imageInfo(webp)?.width, imageInfo(webp)?.height], [100, 50]);
  assert.equal(imageInfo(Buffer.from('not an image')), undefined);
});

test('renderer crops to a square and paints escaped captions', async () => {
  const rendered = await renderSticker(source(), { text: '打工人的一天 <&>', position: 'bottom', size: 256 }, signal());

  assert.equal(rendered.animated, false);
  assert.deepEqual([...rendered.data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(rendered.data.readUInt32BE(16), 256);
  assert.equal(rendered.data.readUInt32BE(20), 256);
  assert.ok(rendered.data.length > 1000);
  const contain = await renderSticker(source(), { size: 128, fit: 'contain' }, signal());
  assert.deepEqual([contain.data.readUInt32BE(16), contain.data.readUInt32BE(20)], [128, 128]);
  for (const [options, message] of [
    [{ size: 100 }, /尺寸需要/],
    [{ text: '字'.repeat(41) }, /最多 40/],
    [{ position: 'middle' }, /位置无效/],
    [{ fit: 'stretch' }, /裁切方式无效/]
  ])
    assert.throws(() => stickerSvg(source(), 'image/png', options), message);
  const svg = stickerSvg(source(), 'image/png', { text: '<script>' });
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  await assert.rejects(renderSticker(Buffer.from('bad'), {}, signal()), /格式不支持/);
  const bomb = source();
  bomb.writeUInt32BE(9000, 16);
  await assert.rejects(renderSticker(bomb, {}, signal()), /尺寸过大/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderSticker(source(), {}, controller.signal));
});

const context = (overrides = {}) => ({
  channelId: 'private:100',
  userId: '100',
  platform: 'onebot',
  private: true,
  owner: true,
  userText: '把这张图做成表情包，写上打工人的一天',
  capabilities: { chat: true, web: false, files: false, terminal: false },
  signal: signal(),
  onCurrentImages: async () => [source()],
  onSticker: async () => undefined,
  ...overrides
});

test('make_sticker stores a rendered sticker, deduplicates and reports real delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-forge-'));
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: { stickerRoot: root } } } };
  const tools = [];
  stickerModule().setup({ tool: tool => tools.push(tool) });
  const make = tools.find(tool => tool.name === 'make_sticker');
  const sent = [];
  const ctx = context({ onSticker: async (item, data) => sent.push({ item, data }) });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    assert.equal(make.available(ctx), true);
    assert.equal(make.available({ ...ctx, owner: false }), false);
    assert.equal(make.available({ ...ctx, autonomous: true }), false);
    const result = await make.execute({ text: '打工人的一天', tags: ['打工人'] }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.sent, true);
    assert.equal(result.animated, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].item.id, result.id);
    assert.deepEqual(sent[0].item.tags, ['打工人']);
    assert.equal(sent[0].data.readUInt32BE(16), 300);
    const items = await listStickers(getMediaConfig());
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].tags, ['打工人']);
    const again = await make.execute({ text: '打工人的一天', tags: ['打工人'] }, ctx);
    assert.equal(again.ok, true);
    assert.equal(again.existing, true);
    assert.equal(again.id, result.id);
    assert.equal(sent.length, 2);
    const fromLibrary = await make.execute({ source: 'library', id: result.id, text: '', size: 200, tags: ['二创'], send: false }, ctx);
    assert.equal(fromLibrary.ok, true);
    assert.equal(fromLibrary.sent, false);
    assert.equal(fromLibrary.source, result.id);
    assert.equal((await listStickers(getMediaConfig())).length, 2);
    assert.equal((await make.execute({ text: 'x' }, { ...ctx, userText: '不要做成表情包' })).ok, false);
    assert.equal((await make.execute({ text: 'x' }, { ...ctx, onCurrentImages: async () => [] })).ok, false);
    assert.equal((await make.execute({ text: 'x' }, { ...ctx, onCurrentImages: undefined })).ok, false);
    assert.equal((await make.execute({ source: 'library', id: 'missing', text: 'x' }, ctx)).ok, false);
    assert.equal((await make.execute({ text: 'x' }, { ...ctx, onSticker: undefined, send: false })).ok, true);
    const failedSend = await make.execute(
      { text: '失败一次' },
      {
        ...ctx,
        onSticker: async () => {
          throw new Error('transport');
        }
      }
    );
    assert.equal(failedSend.ok, true);
    assert.equal(failedSend.sent, false);
    assert.match(failedSend.message, /发送未完成/);
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('owner can collect the single current image in a group chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-group-collect-'));
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: { stickerRoot: root } } } };
  const tools = [];
  stickerModule().setup({ tool: tool => tools.push(tool) });
  const collect = tools.find(tool => tool.name === 'collect_sticker');
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    const ctx = context({ private: false, userText: '收藏这张图', onStickerCollect: async () => source() });
    assert.equal(collect.available(ctx), true);
    const result = await collect.execute({ tags: ['群收藏'] }, ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(
      (await listStickers(getMediaConfig())).map(item => item.tags),
      [['群收藏']]
    );
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('model turn can forge the current image and receive the real delivery result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-forge-turn-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  const stickers = join(root, 'stickers');
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        media: { stickerRoot: stickers }
      }
    }
  };
  await mkdir(stickers);
  await writeFile(join(stickers, 'manifest.json'), '[]');
  const config = getDSHConfig();
  let calls = 0;
  let delivered = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    assert.ok(body.tools.some(tool => tool.function.name === 'make_sticker'));
    if (calls === 1) {
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'forge', type: 'function', function: { name: 'make_sticker', arguments: '{"text":"打工人"}' } }]
            }
          }
        ]
      });
    }
    const result = JSON.parse(body.messages.find(message => message.role === 'tool').content);
    assert.equal(result.ok, true);
    assert.equal(result.sent, true);
    assert.equal(delivered, 1);
    return Response.json({ choices: [{ message: { content: '做好了。' } }] });
  };
  try {
    await runModuleTurn({
      config,
      sessionId: 'sticker-forge',
      input: [
        { type: 'text', text: '把这张图做成表情包' },
        { type: 'image', mimeType: 'image/png', data: source().toString('base64') }
      ],
      context: context(),
      onCurrentImages: async () => [source()],
      onSticker: async () => {
        delivered++;
      },
      onEvent: async () => {}
    });
    assert.equal(calls, 2);
    assert.equal(delivered, 1);
    assert.deepEqual(
      (await listStickers(getMediaConfig())).map(item => item.tags),
      [['表情']]
    );
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = previous;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});
