import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { getMediaConfig } from '../lib/media/config.js';
import { initializeAdminPanel, disposeAdminPanel } from '../lib/panel/admin-panel.js';
import { readImageSettings, saveImageSettings, migrateImageSettings, previewImage } from '../lib/panel/image-service.js';
const provider = {
  baseUrl: 'https://example.com/v1',
  apiKey: 'image-library-secret',
  model: 'image-test',
  size: '512x512',
  stylePrompt: '水彩',
  ownerOnly: true
};
test('image library selects and disables the actual chat provider, validates duplicates', () => {
  const item = { id: 'one', name: '测试', enabled: true, provider };
  assert.equal(getMediaConfig({ media: { imageLibrary: [item], activeImage: 'one' } }).imageGen.model, 'image-test');
  assert.equal(getMediaConfig({ media: { imageGen: provider, imageLibrary: [{ ...item, enabled: false }], activeImage: 'one' } }).imageGen, undefined);
  assert.throws(() => getMediaConfig({ media: { imageLibrary: [item, item] } }));
  assert.throws(() => getMediaConfig({ media: { activeImage: 'missing' } }));
});
test('legacy migration keeps secrets, revision conflicts, and admin image preview respects AI switch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'images-library-'));
  const path = join(root, 'config.yaml');
  const oldConfig = globalThis.__config;
  const oldFetch = globalThis.fetch;
  try {
    await writeFile(path, JSON.stringify({ 'alemonjs-agent-link': { media: { imageGen: provider } } }));
    globalThis.__config = { path, value: { 'alemonjs-agent-link': { budget: { enabled: true } } }, reload() {} };
    await initializeAdminPanel();
    const initial = await readImageSettings();
    assert.equal(initial.legacyAvailable, true);
    const result = await migrateImageSettings({ revision: initial.revision });
    assert.equal(JSON.stringify(result).includes(provider.apiKey), false);
    const media = parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].media;
    assert.deepEqual(media.imageLibrary[0].provider, provider);
    assert.equal(media.activeImage, 'legacy-image');
    await assert.rejects(saveImageSettings(initial), /配置已/);
    globalThis.__config.value['alemonjs-agent-link'].media = media;
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).prompt, '水彩，小鲸鱼');
      return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    };
    assert.deepEqual(await previewImage({ id: 'legacy-image', prompt: '小鲸鱼' }), png);
    assert.equal(calls, 1);
    globalThis.__config.value['alemonjs-agent-link'].aiEnabled = false;
    await assert.rejects(previewImage({ id: 'legacy-image', prompt: '小鲸鱼' }), /关闭/);
    assert.equal(calls, 1);
    await assert.rejects(previewImage({ id: 'missing', prompt: '小鲸鱼' }));
  } finally {
    disposeAdminPanel();
    globalThis.__config = oldConfig;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});
