import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkModel } from '../lib/panel/work-model.js';

test('work model uses top-level defaults and rejects unsafe or unrelated fields', () => {
  const valid = {baseUrl:'https://example.com/v1/',apiKey:'test-secret',model:'test'};
  assert.equal(validateWorkModel(valid).baseUrl, 'https://example.com/v1');
  assert.throws(() => validateWorkModel(undefined));
  assert.equal(validateWorkModel({...valid, apiKey:''}).apiKey, '');
  assert.deepEqual(validateWorkModel({}), {apiKey:'', baseUrl:'https://api.deepseek.com', model:'deepseek-v4-flash', provider:'deepseek-official'});
  assert.throws(() => validateWorkModel({provider:'custom'}));
  assert.throws(() => validateWorkModel({...valid, baseUrl:'http://example.com'}));
  assert.throws(() => validateWorkModel({...valid, baseUrl:'https://user:pass@example.com'}));
  assert.throws(() => validateWorkModel({...valid, baseUrl:'https://example.com?key=secret'}));
  assert.throws(() => validateWorkModel({...valid, modelPool:{}}));
});

test('work model projection remains readable when unrelated runtime settings are invalid', async () => {
  const { projectWorkModel } = await import('../lib/panel/work-model.js');
  const result = projectWorkModel({ revision: 'revision', source: JSON.stringify({ 'alemonjs-agent-link': {
    model: 'custom-model', requestTimeoutMs: -1, modelPool: { endpoints: 'invalid' }
  } }) });
  assert.equal(result.values.model, 'custom-model');
  assert.equal(result.values.provider, 'deepseek-official');
  assert.equal(result.revision, 'revision');
});

test('work model HTTP validation returns actionable messages without reflecting credentials', async () => {
  const { default: Koa } = await import('koa');
  const { default: router } = await import('../lib/api-router.js');
  const app = new Koa();
  app.use(router.routes());
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/work-model`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: 'test', values: { baseUrl: 'https://example.com?key=private-secret', apiKey: 'private-secret' } })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.message, /HTTPS/);
    assert.ok(!JSON.stringify(body).includes('private-secret'));
    assert.equal(body.data, null);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
