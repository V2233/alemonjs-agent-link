import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/client.js';
import { startStickerPanel, stickerPanelConfig } from '../lib/panel/sticker-panel.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const token = 'panel-token-0123456789abcdef';
const settings = { panel: { enabled: true, port: 8787, token } };

test('panel configuration requires loopback, a valid port and a strong token', () => {
  const defaults = stickerPanelConfig(getDSHConfig({}));

  assert.equal(defaults.enabled, true);
  assert.equal(defaults.token, '');
  for (const panel of [
    { enabled: true, port: 8787, token: 'short' },
    { enabled: true, port: 0, token },
    { enabled: true, port: 8787, token, host: '0.0.0.0' }
  ]) {
    const config = getDSHConfig({ modules: { settings: { stickers: { panel } } } });

    assert.throws(() => stickerPanelConfig(config));
  }
  assert.equal(stickerPanelConfig(getDSHConfig({ modules: { settings: { stickers: settings } } })).port, 8787);
});

test('loopback panel lists, uploads, serves, renames and removes stickers with token auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-panel-'));
  const previous = globalThis.__config;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        media: { stickerRoot: root },
        modules: { settings: { stickers: settings } }
      }
    }
  };
  await writeFile(join(root, 'manifest.json'), '[]');
  const config = getDSHConfig();
  const panel = await startStickerPanel(config, 0);
  const base = `http://127.0.0.1:${panel.port}`;
  const auth = { Authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(`${base}/api/stickers`)).status, 401);
    assert.equal((await fetch(`${base}/api/stickers?token=wrong-token-0123456789`)).status, 401);
    const page = await fetch(`${base}/?token=${token}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AgentLink 表情库/);
    const empty = await (await fetch(`${base}/api/stickers`, { headers: auth })).json();
    assert.deepEqual(empty.items, []);
    const upload = await fetch(`${base}/api/stickers`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: png.toString('base64'), name: '猫猫', tags: ['开心'] })
    });
    assert.equal(upload.status, 200);
    const uploaded = await upload.json();
    assert.equal(uploaded.item.name, '猫猫');
    assert.deepEqual(uploaded.item.tags, ['开心']);
    const image = await fetch(`${base}/api/stickers/${uploaded.item.id}/image?token=${token}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const renamed = await fetch(`${base}/api/stickers/${uploaded.item.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新名字', tags: ['晚安', '可爱'] })
    });
    assert.equal(renamed.status, 200);
    const renamedBody = await renamed.json();
    assert.equal(renamedBody.item.name, '新名字');
    assert.deepEqual(renamedBody.item.tags, ['晚安', '可爱']);
    assert.equal((await fetch(`${base}/api/stickers/..`, { headers: auth })).status, 404);
    const deleted = await fetch(`${base}/api/stickers/${uploaded.item.id}`, { method: 'DELETE', headers: auth });
    assert.equal(deleted.status, 200);
    const after = await (await fetch(`${base}/api/stickers`, { headers: auth })).json();
    assert.deepEqual(after.items, []);
    assert.equal((await fetch(`${base}/api/stickers/${uploaded.item.id}`, { method: 'DELETE', headers: auth })).status, 404);
    const invalid = await fetch(`${base}/api/stickers`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'not-base64' })
    });
    assert.equal(invalid.status, 400);
  } finally {
    await panel.close();
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('panel generates and reuses a token file when none is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sticker-panel-token-'));
  const previous = globalThis.__config;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        media: { stickerRoot: join(root, 'stickers') },
        modules: { settings: { stickers: { panel: { enabled: true, port: 8787 } } } }
      }
    }
  };
  const config = getDSHConfig();
  let first;
  let second;
  try {
    first = await startStickerPanel(config, 0);
    const tokenFile = join(root, 'sticker-panel-token.txt');
    const stored = (await readFile(tokenFile, 'utf8')).trim();
    assert.equal(first.token, stored);
    assert.equal(first.token.length, 64);
    const response = await fetch(`http://127.0.0.1:${first.port}/api/stickers?token=${stored}`);
    assert.equal(response.status, 200);
    await first.close();
    first = undefined;
    second = await startStickerPanel(config, 0);
    assert.equal(second.token, stored);
    await second.close();
    second = undefined;
  } finally {
    await first?.close();
    await second?.close();
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});
