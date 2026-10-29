import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QAStore } from '../lib/qa/store.js';

test('knowledge edits retain identity, reject stale writes and enforce scope and unique questions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-management-'));
  const store = new QAStore(join(dir, 'qa.db'), () => 1000);
  const scope = { platform: 'qq', channelId: 'example' };
  try {
    const first = store.addExplicit(scope, { question: '配送需要多久', answer: '三天' });
    const other = store.addExplicit(scope, { question: '可以退货吗', answer: '可以' });
    assert.throws(() => store.edit('global', first.id, first.updatedAt, { question: first.question, answer: '一天' }), /不存在/);
    assert.throws(() => store.edit(scope, first.id, first.updatedAt, { question: other.question, answer: '一天' }), /相同问题/);
    const updated = store.edit(scope, first.id, first.updatedAt, { question: '配送要几天', answer: '一天' });
    assert.equal(updated.id, first.id);
    assert.equal(updated.updatedAt, 1001);
    assert.equal(store.search(scope, '配送要几天', 1, { record: false })[0].answer, '一天');
    assert.throws(() => store.edit(scope, first.id, first.updatedAt), /变化/);
    store.edit(scope, updated.id, updated.updatedAt);
    assert.equal(store.get(scope, first.id), undefined);
    assert.deepEqual(store.scopes(), [scope]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('built-in answer edits and deletions survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-builtins-'));
  const path = join(dir, 'qa.db');
  let store = new QAStore(path);
  try {
    const [edited, deleted] = store.listGlobal();
    store.edit('global', edited.id, edited.updatedAt, { question: edited.question, answer: '维护后的标准答案' });
    store.edit('global', deleted.id, deleted.updatedAt);
    store.close();
    store = new QAStore(path);
    assert.equal(store.listGlobal(200).find(row => row.id === edited.id).answer, '维护后的标准答案');
    assert.equal(
      store.listGlobal(200).some(row => row.id === deleted.id),
      false
    );
    assert.equal(
      store.searchGlobal(deleted.question).some(row => row.id === deleted.id),
      false
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('product APIs select recorded sessions, apply personas through reset, and edit knowledge', async () => {
  const { default: Koa } = await import('koa');
  const { default: router } = await import('../lib/api-router.js');
  const { getDSHConfig } = await import('../lib/dsh/runtime-config.js');
  const { getQAStore } = await import('../lib/qa/store.js');
  const { getPersonaStore } = await import('../lib/companion/personas.js');
  const { SessionRegistry } = await import('../lib/state/registry.js');
  const dir = await mkdtemp(join(tmpdir(), 'product-api-'));
  const previous = globalThis.__config;
  const scope = { platform: 'qq', channelId: 'private:product-test' };
  let server;
  try {
    globalThis.__config = {
      value: { 'alemonjs-agent-link': { runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(dir, 'work'), dshHomeRoot: join(dir, 'home') } }
    };
    const config = getDSHConfig();
    const qa = getQAStore(config);
    const entry = qa.addExplicit(scope, { question: '测试问题', answer: '初始答案' });
    const registry = new SessionRegistry(config);
    const before = await registry.meta(scope.channelId);
    const app = new Koa();
    app.use(router.routes()).use(router.allowedMethods());
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/admin/';
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await (await fetch(base + 'sessions')).json()).data[0].channelId, scope.channelId);
    assert.equal((await post('persona-selection', { ...scope, channelId: 'unknown', id: 'assistant' })).status, 400);
    assert.equal((await post('persona-selection', { ...scope, id: 'assistant' })).status, 200);
    assert.equal(getPersonaStore(config).selected(scope), 'assistant');
    assert.equal((await registry.meta(scope.channelId)).generation, before.generation + 1);
    assert.equal((await post('persona-selection', scope)).status, 200);
    assert.equal(getPersonaStore(config).selected(scope), undefined);
    const edited = await post('knowledge/edit', {
      ...scope,
      id: entry.id,
      updatedAt: entry.updatedAt,
      action: 'save',
      question: entry.question,
      answer: '更新答案'
    });
    assert.equal(edited.status, 200);
    const updated = (await edited.json()).data;
    assert.equal(updated.answer, '更新答案');
    assert.equal((await post('knowledge/edit', { ...scope, id: entry.id, updatedAt: entry.updatedAt, action: 'delete' })).status, 409);
    assert.equal((await post('knowledge/edit', { ...scope, id: entry.id, updatedAt: updated.updatedAt, action: 'delete' })).status, 200);
    assert.equal(qa.get(scope, entry.id), undefined);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    globalThis.__config = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
