import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMediaConfig } from '../lib/media/config.js';
import { collectSticker, updateSticker, listStickers, loadSticker } from '../lib/media/stickers.js';
import { stickerModule } from '../lib/modules/stickers.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { runModuleTurn } from '../lib/agent/turn.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const signal = () => new AbortController().signal;
const ctx = overrides => ({
  platform: 'onebot',
  botId: '900',
  channelId: 'private:100',
  userId: '100',
  private: true,
  owner: true,
  userText: '帮我收藏这张图片做表情',
  capabilities: { chat: true, web: false, files: false, terminal: false },
  signal: signal(),
  onStickerCollect: async () => png,
  ...overrides
});

test('collection stores and deduplicates images while edits preserve original assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-store-'));
  const config = getMediaConfig({ media: { stickerRoot: root } });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    const first = await collectSticker(config, png, ['开心'], signal());
    assert.equal(first.existing, false);
    const repeat = await collectSticker(config, png, ['别的'], signal());
    assert.equal(repeat.id, first.id);
    assert.equal(repeat.existing, true);
    let items = await listStickers(config);
    assert.equal(items.length, 1);
    assert.deepEqual(await loadSticker(items[0], config), png);
    assert.equal(await updateSticker(config, first.id, ['鲸鱼', '快乐'], signal()), true);
    items = await listStickers(config);
    assert.deepEqual(items[0].tags, ['鲸鱼', '快乐']);
    const filename = items[0].file;
    assert.equal(await updateSticker(config, first.id, null, signal()), true);
    assert.deepEqual(await listStickers(config), []);
    assert.deepEqual(await readFile(join(root, filename)), png);
    assert.equal(await updateSticker(config, 'missing', null, signal()), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('collection respects locks, cancellation, limits and directory boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-lock-'));
  const outside = await mkdtemp(join(tmpdir(), 'sticker-outside-'));
  const config = getMediaConfig({ media: { stickerRoot: root } });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    await writeFile(join(root, '.agentlink-sticker.lock'), 'locked');
    await assert.rejects(collectSticker(config, png, [], signal()), /正在修改/);
    await rm(join(root, '.agentlink-sticker.lock'));
    await symlink(outside, join(root, 'managed'));
    await assert.rejects(collectSticker(config, png, [], signal()), /素材目录无效/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), []);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(collectSticker(config, png, [], controller.signal));
    await assert.rejects(collectSticker(config, Buffer.from('invalid'), [], signal()), /格式无效/);
    await assert.rejects(collectSticker(config, png, ['重复', '重复'], signal()), /标签无效/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('concurrent collection never silently overwrites another manifest update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-concurrent-'));
  const config = getMediaConfig({ media: { stickerRoot: root } });
  const other = Buffer.concat([png, Buffer.from('second')]);
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    const attempted = await Promise.allSettled([collectSticker(config, png, ['一'], signal()), collectSticker(config, other, ['二'], signal())]);
    for (let i = 0; i < attempted.length; i++) {
      if (attempted[i].status === 'rejected') await collectSticker(config, i === 0 ? png : other, [i === 0 ? '一' : '二'], signal());
    }
    const items = await listStickers(config);
    assert.equal(items.length, 2);
    assert.deepEqual(new Set(items.flatMap(item => item.tags)), new Set(['一', '二']));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tools require owner intent and prevent an identifier prefix from authorizing edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-permission-'));
  const old = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: { stickerRoot: root } } } };
  const tools = [];
  stickerModule().setup({ tool: tool => tools.push(tool) });
  const collect = tools.find(tool => tool.name === 'collect_sticker');
  const manage = tools.find(tool => tool.name === 'manage_sticker');
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    assert.equal(collect.available(ctx({ owner: false })), false);
    assert.equal((await collect.execute({ tags: ['开心'] }, ctx({ userText: '不要收藏这张图片' }))).ok, false);
    const result = await collect.execute({ tags: ['开心'] }, ctx());
    assert.equal(result.ok, true);
    assert.equal((await manage.execute({ id: result.id, action: 'remove' }, ctx({ userText: `删除 ${result.id}extra` }))).ok, false);
    assert.equal((await manage.execute({ id: result.id, action: 'name', name: '开心猫' }, ctx({ userText: `给 ${result.id} 改名 开心猫` }))).ok, true);
    assert.equal((await listStickers(getMediaConfig()))[0].name, '开心猫');
    assert.equal((await manage.execute({ id: result.id, action: 'tags', tags: ['可爱'] }, ctx({ userText: `修改 ${result.id} 标签` }))).ok, true);
    assert.equal((await manage.execute({ id: result.id, action: 'remove' }, ctx({ userText: `删除 ${result.id}` }))).ok, true);
  } finally {
    globalThis.__config = old;
    await rm(root, { recursive: true, force: true });
  }
});

test('multimodal model turn can collect the actual attachment through the tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-model-'));
  const oldConfig = globalThis.__config;
  const oldFetch = globalThis.fetch;
  const stickers = join(root, 'stickers');
  await mkdir(stickers);
  await writeFile(join(stickers, 'manifest.json'), '[]');
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        modules: { settings: { mood: { modelJudge: false }, expression: { automatic: false } } },
        media: { stickerRoot: stickers }
      }
    }
  };
  const config = getDSHConfig();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    calls++;
    assert.ok(request.tools.some(item => item.function.name === 'collect_sticker'));
    if (calls === 1)
      return Response.json({
        choices: [
          {
            message: { content: null, tool_calls: [{ id: 'collect', type: 'function', function: { name: 'collect_sticker', arguments: '{"tags":["开心"]}' } }] }
          }
        ]
      });
    assert.equal(JSON.parse(request.messages.find(item => item.role === 'tool').content).ok, true);
    return Response.json({ choices: [{ message: { content: '收藏好了。' } }] });
  };
  try {
    await runModuleTurn({
      config,
      sessionId: 'sticker-collection',
      input: [
        { type: 'text', text: '收藏图片做表情' },
        { type: 'image', mimeType: 'image/png', data: png.toString('base64') }
      ],
      context: ctx(),
      onStickerCollect: async () => png,
      onEvent: async () => {}
    });
    assert.equal(calls, 2);
    assert.deepEqual(
      (await listStickers(getMediaConfig())).map(item => item.tags),
      [['开心']]
    );
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = oldConfig;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});
