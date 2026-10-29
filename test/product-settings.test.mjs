import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ProductSettingsFile as ConfigStore, hiddenSecret } from '../lib/panel/product-settings-file.js';

test('admin store masks secrets, validates, detects conflicts, preserves comments and creates backups', async () => {
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('product routes work while removed configuration endpoints cannot read or write', async () => {
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
    globalThis.__config = {
      path,
      value: { 'alemonjs-agent-link': { workspaceRoot: join(dir, 'workspace') } },
      reload() {
        reloads++;
      }
    };
    await initializeAdminPanel();
    const app = new Koa();
    const { registerRuntimeApp, setRuntimeAppKoaRouters } = await import('alemonjs');
    const { default: frameworkRouter } = await import('../node_modules/alemonjs/lib/application/runtime/http/routers/router.js');
    for (const name of ['main', 'alemonjs-agent-link']) {
      registerRuntimeApp({
        name,
        kind: name === 'main' ? 'main' : 'plugin',
        enabled: true,
        status: 'ready',
        rootDir: process.cwd(),
        mainPath: join(process.cwd(), 'lib/index.js'),
        capabilities: { httpApi: true, web: true }
      });
      setRuntimeAppKoaRouters(name, router);
    }
    app.use(frameworkRouter.routes());
    app.use(frameworkRouter.allowedMethods());
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/app/api/admin/config';
    const headers = { 'Content-Type': 'application/json' };
    const original = await readFile(path, 'utf8');
    for (const mount of ['/app/', '/apps/alemonjs-agent-link/']) {
      for (const endpoint of ['config', 'validate', 'restore', 'history', 'status']) {
        for (const method of ['GET', 'POST']) {
          const response = await fetch(url.replace('/app/', mount).replace('/config', '/' + endpoint), {
            method,
            headers,
            ...(method === 'POST' ? { body: JSON.stringify({ source: '{}', revision: 'anything' }) } : {})
          });
          assert.equal(response.status, 404);
        }
      }
    }
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(reloads, 0);
    const settingsUrl = url.replace('/config', '/pool/settings');
    const initial = (await (await fetch(settingsUrl)).json()).data;
    assert.equal(initial.source, undefined);
    assert.equal(initial.apiKey, undefined);
    assert.ok(!JSON.stringify(initial).includes('private-secret'));
    const post = body => fetch(settingsUrl, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post({ revision: initial.revision, action: 'rules', values: { privateAutoReply: false } })).status, 400);
    assert.equal((await post({ revision: initial.revision, action: 'rules', values: { enabled: false }, source: '{}' })).status, 400);
    assert.equal((await post({ revision: initial.revision, action: 'rules', values: { enabled: false } })).status, 200);
    assert.equal(reloads, 1);
    assert.equal(parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].apiKey, 'private-secret');
    assert.equal((await post({ revision: initial.revision, action: 'rules', values: { enabled: true } })).status, 409);
    const latest = (await (await fetch(settingsUrl)).json()).data;
    const endpoint = { id: 'first', provider: 'test', model: 'test', baseUrl: 'https://example.com', apiKey: 'endpoint-private-key' };
    assert.equal((await post({ revision: latest.revision, action: 'endpoint', values: endpoint })).status, 200);
    const withEndpoint = (await (await fetch(settingsUrl)).json()).data;
    assert.ok(!JSON.stringify(withEndpoint).includes(endpoint.apiKey));
    assert.equal(
      (await post({ revision: withEndpoint.revision, action: 'endpoint', id: 'first', values: { ...withEndpoint.modelPool.endpoints[0], weight: 2 } })).status,
      200
    );
    assert.equal(parse(await readFile(path, 'utf8'))['alemonjs-agent-link'].modelPool.endpoints[0].apiKey, endpoint.apiKey);
    const beforeRemove = (await (await fetch(settingsUrl)).json()).data;
    assert.equal((await post({ revision: beforeRemove.revision, action: 'remove', id: 'first' })).status, 200);
    assert.deepEqual((await (await fetch(settingsUrl)).json()).data.modelPool.endpoints, []);
    const personasUrl = url.replace('/config', '/personas');
    const persona = { revision: '', id: 'test-persona', name: '测试人设', prompt: '只用于临时测试' };
    assert.equal((await fetch(personasUrl, { method: 'POST', headers, body: JSON.stringify(persona) })).status, 200);
    const personas = (await (await fetch(personasUrl)).json()).data;
    assert.equal(personas.find(item => item.id === 'test-persona').prompt, persona.prompt);
    const knowledgeUrl = url.replace('/config', '/knowledge');
    assert.equal(
      (
        await fetch(knowledgeUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ scope: 'global', question: '测试问题是什么？', answer: '测试标准答案。' })
        })
      ).status,
      200
    );
    const knowledge = (await (await fetch(knowledgeUrl)).json()).data;
    assert.ok(knowledge.some(item => item.question === '测试问题是什么？'));
    const searchUrl = knowledgeUrl + '/search';
    const hitsBefore = knowledge.find(item => item.question === '测试问题是什么？').hits;
    const searched = await (await fetch(searchUrl, { method: 'POST', headers, body: JSON.stringify({ query: '测试问题是什么？' }) })).json();
    assert.ok(searched.data.some(item => item.question === '测试问题是什么？'));
    const afterSearch = (await (await fetch(knowledgeUrl)).json()).data;
    assert.equal(afterSearch.find(item => item.question === '测试问题是什么？').hits, hitsBefore);
    const styleUrl = url.replace('/config', '/persona-style');
    assert.equal((await fetch(styleUrl, { method: 'POST', headers, body: JSON.stringify({ mode: '专业' }) })).status, 200);
    assert.equal((await (await fetch(styleUrl)).json()).data.mode, '专业');
    const additionsUrl = url.replace('/config', '/persona-additions');
    assert.equal((await fetch(additionsUrl, { method: 'POST', headers, body: JSON.stringify({ id: 'test-persona', text: '言简意赅' }) })).status, 200);
    const updatedPersona = (await (await fetch(personasUrl)).json()).data.find(item => item.id === 'test-persona');
    assert.equal(updatedPersona.additions, '言简意赅');
    const privateKnowledge = (await (await fetch(knowledgeUrl + '?platform=test&channelId=other')).json()).data;
    assert.ok(!privateKnowledge.some(item => item.question === '测试问题是什么？'));
    disposeAdminPanel();
    assert.equal((await fetch(settingsUrl, { headers })).status, 400);
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
