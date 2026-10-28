import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMediaConfig } from '../lib/media/config.js';
import { importStickerUrls } from '../lib/media/sticker-import.js';
import { listStickers } from '../lib/media/stickers.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const signal = () => new AbortController().signal;

test('favorite import deduplicates, skips invalid bytes and reports failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-import-'));
  const config = getMediaConfig({ media: { stickerRoot: root } });
  const download = async url => {
    if (url.endsWith('/bad')) return Buffer.from('not an image');
    if (url.endsWith('/throw')) throw new Error('network');
    return png;
  };
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    const result = await importStickerUrls(
      config,
      ['https://cdn.test/a', 'https://cdn.test/dup', 'https://cdn.test/bad', 'https://cdn.test/throw'],
      signal(),
      download
    );
    assert.deepEqual(result, { total: 4, added: 1, existing: 1, failed: 2 });
    const items = await listStickers(config);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].tags, ['导入']);
    assert.equal(items[0].from, 'import');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('favorite import caps the batch, honors cancellation and requires a library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-import-cap-'));
  const config = getMediaConfig({ media: { stickerRoot: root, stickerMaxItems: 1 } });
  const signalValue = new AbortController();
  try {
    await writeFile(join(root, 'manifest.json'), '[]');
    let calls = 0;
    const result = await importStickerUrls(config, ['https://cdn.test/a', 'https://cdn.test/a2', 'https://cdn.test/a3'], signalValue.signal, async () => {
      calls++;
      return calls === 1 ? png : Buffer.concat([png, Buffer.from([calls])]);
    });
    assert.deepEqual(result, { total: 3, added: 1, existing: 0, failed: 2 });
    signalValue.abort();
    await assert.rejects(importStickerUrls(config, ['https://cdn.test/b'], signalValue.signal, async () => png));
    await assert.rejects(
      importStickerUrls({ ...config, stickerRoot: undefined }, ['https://cdn.test/a'], signal(), async () => png),
      /素材目录/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
