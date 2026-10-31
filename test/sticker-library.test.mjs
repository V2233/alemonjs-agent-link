import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMediaConfig } from '../lib/media/config.js';
import { chooseSticker, collectSticker, ensureStickerRoot, listAssets, listStickers, markStickerUsed } from '../lib/media/stickers.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const image = suffix => Buffer.concat([png, Buffer.from([suffix])]);
const signal = () => new AbortController().signal;

test('sticker metadata, names and usage survive the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-library-'));
  const config = getMediaConfig({ media: { stickerRoot: root, stickerMaxItems: 3 } });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    const first = await collectSticker(config, png, ['开心'], signal(), { from: 'auto', name: '猫猫', confidence: 0.9 });
    assert.equal(first.existing, false);
    assert.equal(first.item.name, '猫猫');
    assert.equal(first.item.from, 'auto');
    assert.equal(first.item.width, 1);
    assert.equal(first.item.height, 1);
    let items = await listStickers(config);
    assert.equal(items.length, 1);
    assert.equal(items[0].bytes, png.length);
    assert.equal(chooseSticker(items, '猫猫').id, first.id);
    assert.equal(await markStickerUsed(config, first.id, signal()), true);
    items = await listStickers(config);
    assert.equal(items[0].uses, 1);
    assert.ok(items[0].lastUsed > 0);
    const repeat = await collectSticker(config, png, ['晚安'], signal(), { from: 'auto', name: '别的名字' });
    assert.equal(repeat.existing, true);
    assert.deepEqual(repeat.item.tags, ['开心', '晚安']);
    assert.equal(repeat.item.name, '猫猫');
    assert.equal((await listStickers(config)).length, 1);
    const avatar = await collectSticker(config, image(9), ['头像', '蓝发'], signal(), { from: 'manual', kind: 'avatar', category: '头像', name: '鲸鱼娘头像' });
    assert.equal(avatar.item.kind, 'avatar');
    assert.equal(avatar.item.category, '头像');
    assert.equal((await listStickers(config)).length, 1);
    assert.equal((await listAssets(config)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capacity evicts the least-used automatic sticker and keeps manual entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-evict-'));
  const config = getMediaConfig({ media: { stickerRoot: root, stickerMaxItems: 2 } });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    const first = await collectSticker(config, image(1), ['一'], signal(), { from: 'auto', name: 'A', addedAt: 1 });
    const second = await collectSticker(config, image(2), ['二'], signal(), { from: 'auto', name: 'B', addedAt: 2 });
    assert.equal(await markStickerUsed(config, second.id, signal()), true);
    const third = await collectSticker(config, image(3), ['三'], signal(), { from: 'auto', name: 'C' });
    let items = await listStickers(config);
    assert.deepEqual(
      items.map(item => item.name),
      ['B', 'C']
    );
    await assert.rejects(access(join(root, first.item.file)), { code: 'ENOENT' });
    const fourth = await collectSticker(config, image(4), ['四'], signal(), { from: 'auto', name: 'D' });
    items = await listStickers(config);
    assert.deepEqual(
      items.map(item => item.name),
      ['B', 'D']
    );
    await assert.rejects(access(join(root, third.item.file)), { code: 'ENOENT' });
    assert.ok(fourth.item.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manual and forged stickers are not evicted, so a full library fails safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-protected-'));
  const config = getMediaConfig({ media: { stickerRoot: root, stickerMaxItems: 1 } });
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    await collectSticker(config, image(1), ['手'], signal(), { from: 'manual', name: '手动' });
    await assert.rejects(collectSticker(config, image(2), ['新'], signal(), { from: 'auto', name: '自动' }), /表情库已满/);
    const items = await listStickers(config);
    assert.deepEqual(
      items.map(item => item.name),
      ['手动']
    );
    await access(join(root, items[0].file));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest metadata is validated and limits are enforced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-validate-'));
  const config = getMediaConfig({ media: { stickerRoot: root, stickerMaxItems: 1 } });
  try {
    for (const item of [
      { id: 'x', file: 'x.png', tags: [], from: 'unknown' },
      { id: 'x', file: 'x.png', tags: [], name: 'x'.repeat(25) },
      { id: 'x', file: 'x.png', tags: [], confidence: 2 },
      { id: 'x', file: 'x.png', tags: [], uses: -1 }
    ]) {
      await writeFile(join(root, 'manifest.json'), JSON.stringify([item]));
      await assert.rejects(listStickers(config), /格式无效/);
    }
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify([
        { id: 'a', file: 'a.png', tags: [] },
        { id: 'b', file: 'b.png', tags: [] }
      ])
    );
    assert.equal((await listStickers(config)).length, 2);
    assert.throws(() => getMediaConfig({ media: { stickerMaxItems: 0 } }));
    assert.throws(() => getMediaConfig({ media: { stickerMaxItems: 10001 } }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing library is created once without overwriting a manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-ensure-'));
  const config = getMediaConfig({ media: { stickerRoot: join(root, 'nested', 'stickers') } });
  try {
    await ensureStickerRoot(config);
    assert.deepEqual(await listStickers(config), []);
    await writeFile(join(config.stickerRoot, 'manifest.json'), JSON.stringify([{ id: 'keep', file: 'keep.png', tags: [] }]));
    await ensureStickerRoot(config);
    assert.deepEqual(
      (await listStickers(config)).map(item => item.id),
      ['keep']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default capacity is 1200 and large manifests can be read and updated without truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-capacity-'));
  const config = getMediaConfig({ media: { stickerRoot: root } });
  try {
    assert.equal(config.stickerMaxItems, 1200);
    const items = Array.from({ length: 1200 }, (_, i) => ({
      id: `large_${i}`,
      file: `managed/${i}.png`,
      tags: ['测试'],
      context: '使用场景'.repeat(40),
      from: 'manual'
    }));
    const encoded = JSON.stringify(items);
    assert.ok(Buffer.byteLength(encoded) > 256 * 1024);
    await writeFile(join(root, 'manifest.json'), encoded);
    assert.equal((await listAssets(config)).length, 1200);
    await markStickerUsed(config, 'large_1199', signal());
    assert.equal((await listAssets(config)).find(item => item.id === 'large_1199').uses, 1);
    const reduced = getMediaConfig({ media: { stickerRoot: root, stickerMaxItems: 100 } });
    assert.equal((await listAssets(reduced)).length, 1200);
    await assert.rejects(collectSticker(reduced, png, ['新素材'], signal()), /已满/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
