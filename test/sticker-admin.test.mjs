import { readStickerSettings, saveStickerSettings } from '../lib/panel/sticker-service.js';
import { initializeAdminPanel, disposeAdminPanel } from '../lib/panel/admin-panel.js';
import { writeFile, readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stickerAssets, stickerImage, saveStickerAsset, uploadStickerAsset } from '../lib/panel/sticker-service.js';
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
test('admin manages the real sticker library, protects stale edits and validates uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-admin-'));
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { media: { stickerRoot: root } } } };
  try {
    assert.equal((await stickerAssets()).items.length, 0);
    await assert.rejects(uploadStickerAsset({ data: 'not base64', name: 'x', tags: [], kind: 'sticker' }));
    await uploadStickerAsset({ data, name: '猫猫', tags: ['开心'], kind: 'sticker' });
    const item = (await stickerAssets()).items[0];
    assert.equal('file' in item, false);
    assert.equal((await stickerImage(item.id)).mime, 'image/png');
    await assert.rejects(stickerImage('../manifest.json'));
    await saveStickerAsset({ id: item.id, revision: item.revision, name: '新名称', tags: ['晚安'] });
    await assert.rejects(saveStickerAsset({ id: item.id, revision: item.revision }, true), /配置已/);
    const edited = (await stickerAssets()).items[0];
    assert.equal(edited.name, '新名称');
    assert.deepEqual(edited.tags, ['晚安']);
    await saveStickerAsset(edited, true);
    assert.equal((await stickerAssets()).items.length, 0);
    await assert.rejects(stickerImage(item.id));
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('capacity settings persist with revision protection and preserve other configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-settings-'));
  const path = join(root, 'config.yaml');
  const previous = globalThis.__config;
  try {
    await writeFile(path, JSON.stringify({ 'alemonjs-agent-link': { media: { stickerRoot: root, ttsMaxChars: 321 } } }));
    globalThis.__config = { path, value: { 'alemonjs-agent-link': {} }, reload() {} };
    await initializeAdminPanel();
    const initial = await readStickerSettings();
    assert.equal(initial.capacity, 1200);
    await saveStickerSettings({ revision: initial.revision, capacity: 2400 });
    const media = parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].media;
    assert.equal(media.stickerMaxItems, 2400);
    assert.equal(media.ttsMaxChars, 321);
    await assert.rejects(saveStickerSettings({ revision: initial.revision, capacity: 1200 }), /配置已/);
    await assert.rejects(saveStickerSettings({ revision: (await readStickerSettings()).revision, capacity: 0 }));
  } finally {
    disposeAdminPanel();
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});
