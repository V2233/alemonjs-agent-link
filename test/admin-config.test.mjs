import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ConfigStore, hiddenSecret } from '../lib/panel/config-store.js';

test('admin store masks secrets, validates, detects conflicts, preserves comments and restores history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-admin-'));
  const path = join(dir, 'config.yaml');
  try {
    await writeFile(path, '# keep me\nalemonjs-agent-link:\n  apiKey: secret-original\n  model: original\n  requestTimeoutMs: 1000\n');
    const store = new ConfigStore(path);
    const first = await store.read();
    assert.ok(!first.source.includes('secret-original'));
    assert.ok(first.source.includes(hiddenSecret));
    const edited = JSON.parse(first.source);
    edited['alemonjs-agent-link'].model = 'updated';
    const saved = await store.save(JSON.stringify(edited), first.revision);
    const text = await readFile(path, 'utf8');
    assert.ok(text.includes('# keep me'));
    assert.equal(parse(text)['alemonjs-agent-link'].apiKey, 'secret-original');
    assert.equal(parse(text)['alemonjs-agent-link'].model, 'updated');
    await assert.rejects(store.save(first.source, first.revision), /配置已/);
    edited['alemonjs-agent-link'].requestTimeoutMs = -1;
    await assert.rejects(store.save(JSON.stringify(edited), saved.revision), /requestTimeoutMs/);
    assert.equal((await store.read()).revision, saved.revision);
    const history = await store.history();
    await store.restore(history[0], saved.revision);
    assert.equal(parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].model, 'original');
    await assert.rejects(store.restore('../config.yaml', first.revision), /备份不存在/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('masked credentials follow endpoints when array entries are removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-admin-'));
  const path = join(dir, 'config.yaml');
  try {
    const endpoints = ['first', 'second'].map(id => ({ id, provider: 'test', baseUrl: 'https://example.com', model: 'test', apiKey: id + '-secret-key' }));
    await writeFile(path, JSON.stringify({ 'alemonjs-agent-link': { modelPool: { endpoints } } }));
    const store = new ConfigStore(path);
    const data = await store.read();
    const value = JSON.parse(data.source);
    value['alemonjs-agent-link'].modelPool.endpoints.shift();
    await store.save(JSON.stringify(value), data.revision);
    assert.equal(parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].modelPool.endpoints[0].apiKey, 'second-secret-key');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('framework Koa router requires token and saves through the current config', async () => {
  const { default: Koa } = await import('koa');
  const { default: router } = await import('../lib/api-router.js');
  const { initializeAdminPanel, disposeAdminPanel } = await import('../lib/panel/admin-panel.js');
  const dir = await mkdtemp(join(tmpdir(), 'agent-http-'));
  const path = join(dir, 'config.yaml');
  const previous = globalThis.__config;
  let server;
  let reloads = 0;
  try {
    await writeFile(path, 'alemonjs-agent-link:\n  model: test\n  apiKey: private-secret\n');
    globalThis.__config = { path, value: {}, reload() { reloads++; } };
    await initializeAdminPanel();
    const app = new Koa();
    const { registerRuntimeApp, setRuntimeAppKoaRouters } = await import('alemonjs');
    const { default: frameworkRouter } = await import('../node_modules/alemonjs/lib/application/runtime/http/routers/router.js');
    for (const name of ['main', 'alemonjs-agent-link']) {
      registerRuntimeApp({ name, kind: name === 'main' ? 'main' : 'plugin', enabled: true, status: 'ready', rootDir: process.cwd(), mainPath: join(process.cwd(), 'lib/index.js'), capabilities: { httpApi: true, web: true } });
      setRuntimeAppKoaRouters(name, router);
    }
    app.use(frameworkRouter.routes());
    app.use(frameworkRouter.allowedMethods());
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/app/api/admin/config';
    assert.equal((await fetch(url)).status, 401);
    const token = await readFile(join(dir, '.agent-link-admin/token'), 'utf8');
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const pluginResponse = await fetch(url.replace('/app/', '/apps/alemonjs-agent-link/'), { headers });
    assert.equal(pluginResponse.status, 200);
    const snapshot = (await (await fetch(url, { headers })).json()).data;
    assert.ok(!snapshot.source.includes('private-secret'));
    const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify(snapshot) });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).code, 200);
    assert.equal(reloads, 1);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
    disposeAdminPanel();
    assert.equal((await fetch(url, { headers })).status, 401);
  } finally {
    disposeAdminPanel();
    if (server) await new Promise(resolve => server.close(resolve));
    globalThis.__config = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('YAML alias credentials are masked and retained on save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-admin-alias-'));
  const path = join(dir, 'config.yaml');
  try {
    await writeFile(path, 'alemonjs-agent-link:\n  apiKey: &credential private-alias-secret\n  replyGate:\n    apiKey: *credential\n');
    const store = new ConfigStore(path);
    const snapshot = await store.read();
    assert.ok(!snapshot.source.includes('private-alias-secret'));
    assert.ok(JSON.parse(snapshot.source)['alemonjs-agent-link'].replyGate.apiKey.startsWith(hiddenSecret));
    await store.save(snapshot.source, snapshot.revision);
    assert.equal(parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].replyGate.apiKey, 'private-alias-secret');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
