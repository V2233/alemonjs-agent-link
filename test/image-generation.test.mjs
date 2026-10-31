import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getMediaConfig } from '../lib/media/config.js';
import { generateImage, imageGenerationTool } from '../lib/media/image-generation.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { runModuleTurn } from '../lib/agent/turn.js';
import { getModuleRuntime } from '../lib/agent/modules.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const provider = { baseUrl: 'https://image.example/v1', apiKey: 'test', model: 'image-model', size: '512x512', stylePrompt: '水彩' };

test('image provider receives prompt and returns bounded image bytes; malformed and unsafe responses fail', async () => {
  const originalConfig = globalThis.__config;
  const originalFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
  const config = getMediaConfig({ media: { imageGen: provider } });
  const signal = new AbortController().signal;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://image.example/v1/images/generations');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer test');
      assert.deepEqual(JSON.parse(init.body), { model: 'image-model', prompt: '水彩，一只鲸鱼', size: '512x512', n: 1, response_format: 'b64_json' });
      return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    };
    assert.deepEqual(await generateImage('一只鲸鱼', config, signal), png);
    globalThis.fetch = async () => Response.json({ data: [{ b64_json: 'not-base64!' }] });
    await assert.rejects(generateImage('x', config, signal), /编码无效/);
    globalThis.fetch = async () => Response.json({ data: [{ url: 'http://127.0.0.1/private' }] });
    await assert.rejects(generateImage('x', config, signal), /HTTPS/);
    globalThis.fetch = async () => Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
    await assert.rejects(generateImage('x', config, signal), /格式无效/);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(generateImage('x', config, cancelled.signal));
    assert.equal(imageGenerationTool({ ...config, imageGen: { ...config.imageGen, ownerOnly: true } }, async () => {}).available({ owner: false }), false);
    assert.throws(() => getMediaConfig({ media: { imageGen: { ...provider, size: 'invalid' } } }));
    globalThis.__config.value['alemonjs-agent-link'].budget.enabled = true;
    globalThis.fetch = () => assert.fail('unscoped paid request must not be made');
    await assert.rejects(generateImage('x', config, signal), /所属会话/);
  } finally {
    globalThis.__config = originalConfig;
    globalThis.fetch = originalFetch;
  }
});

test('a model tool call generates an image and queues it for the same reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-imagegen-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': {
    apiKey: 'model-key', model: 'chat-model', runtimeMode: 'chat-only', stateBackend: 'local',
    workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), media: { imageGen: provider }
  } } };
  const config = getDSHConfig();
  let modelCalls = 0;
  let providerCalls = 0;
  let delivered;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('images/generations')) {
      providerCalls++;
      return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    }
    modelCalls++;
    const body = JSON.parse(init.body);
    assert.ok(body.tools.some(tool => tool.function.name === 'generate_image'));
    if (modelCalls === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: 'img', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"一只鲸鱼"}' } },
      { id: 'img2', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"另一只"}' } }
    ] } }] });
    assert.equal(JSON.parse(body.messages.find(message => message.role === 'tool').content).delivery, 'queued-for-this-reply');
    assert.notEqual(JSON.parse(body.messages.filter(message => message.role === 'tool')[1].content).ok, true);
    return Response.json({ choices: [{ message: { content: '画好了。' } }] });
  };
  try {
    await runModuleTurn({
      config, sessionId: 'imagegen-test', input: '画一只鲸鱼',
      context: { channelId: 'private:test', userId: '1', platform: 'onebot', private: true, owner: false,
        userText: '画一只鲸鱼', capabilities: { chat: true, web: false, files: false, terminal: false }, signal: new AbortController().signal },
      onImage: async data => { delivered = data; }, onEvent: async () => {}
    });
    assert.equal(providerCalls, 1);
    assert.equal(modelCalls, 2);
    assert.deepEqual(delivered, png);
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = previous;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of ['provider-fails', 'provider-succeeds', 'delivery-fails']) {
  test(`drawing fallback is bounded and only follows generation failure: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'image-fallback-'));
    const previous = globalThis.__config, oldFetch = globalThis.fetch;
    globalThis.__config = { value: { 'alemonjs-agent-link': {
      apiKey: 'fixture', model: 'fixture', runtimeMode: 'chat-only', stateBackend: 'local',
      workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), media: { imageGen: provider }
    } } };
    const config = getDSHConfig();
    let modelCalls = 0, providerCalls = 0, deliveries = 0;
    const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const drawing = { width: 64, height: 64, elements: [{ type: 'circle', x: 32, y: 32, radius: 20, fill: '#0088ff' }] };
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('images/generations')) {
        providerCalls++;
        return scenario === 'provider-fails' ? new Response('', { status: 503 }) : Response.json({ data: [{ b64_json: png.toString('base64') }] });
      }
      modelCalls++;
      const body = JSON.parse(init.body);
      if (modelCalls === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [call('generate', 'generate_image', { prompt: '蓝色圆形' })] } }] });
      if (modelCalls === 2) return Response.json({ choices: [{ message: { content: null, tool_calls: [call('draw', 'draw_image', drawing), call('draw-again', 'draw_image', drawing), call('generate-again', 'generate_image', { prompt: '重试' })] } }] });
      const results = body.messages.filter(m => m.role === 'tool');
      const result = JSON.parse(results.find(m => m.tool_call_id === 'draw').content);
      if (scenario === 'provider-fails') {
        assert.equal(result.fallback, 'local-drawing');
        assert.match(result.notice, /降级/);
      } else assert.notEqual(result.ok, true);
      for (const id of ['draw-again', 'generate-again']) assert.notEqual(JSON.parse(results.find(m => m.tool_call_id === id).content).ok, true);
      return Response.json({ choices: [{ message: { content: '处理完毕。' } }] });
    };
    try {
      await runModuleTurn({
        config, sessionId: `fallback-${scenario}`, input: '画蓝色圆形，失败则绘制',
        context: { channelId: 'private:fixture', userId: '1', platform: 'onebot', private: true, owner: false,
          userText: '画蓝色圆形，失败则绘制', capabilities: { chat: true, web: false, files: false, terminal: false }, signal: new AbortController().signal },
        onImage: async data => {
          deliveries++;
          assert.deepEqual(data.subarray(0, 8), png.subarray(0, 8));
          if (scenario === 'delivery-fails') throw new Error('fixture delivery failed');
        }, onEvent: async () => {}
      });
      assert.equal(providerCalls, 1);
      assert.equal(deliveries, 1);
      assert.equal(modelCalls, 3);
    } finally {
      await (await getModuleRuntime(config)).close();
      globalThis.__config = previous; globalThis.fetch = oldFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('DSH fallback only follows provider failure, reports its source, and never repeats delivery', async () => {
  const oldConfig = globalThis.__config, oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { budget: { enabled: false } } } };
  const config = getMediaConfig({ media: { imageGen: provider, dshImageFallback: true } });
  let fallbackCalls = 0, deliveries = 0;
  const context = { signal: new AbortController().signal };
  const fallback = async () => { fallbackCalls++; return png; };
  try {
    globalThis.fetch = async () => new Response('', { status: 503 });
    const result = await imageGenerationTool(config, async data => { assert.deepEqual(data, png); deliveries++; }, fallback).execute({ prompt: '鲸鱼' }, context);
    assert.equal(result.source, 'dsh-image-gen');
    assert.equal(deliveries, 1);
    assert.equal(fallbackCalls, 1);
    globalThis.fetch = async () => Response.json({ data: [{ b64_json: png.toString('base64') }] });
    await assert.rejects(imageGenerationTool(config, async () => { throw new Error('delivery failed'); }, fallback).execute({ prompt: '鲸鱼' }, context), /delivery failed/);
    assert.equal(fallbackCalls, 1);
    globalThis.fetch = async () => new Response('', { status: 503 });
    const stopped = new AbortController();stopped.abort();
    await assert.rejects(imageGenerationTool(config, async () => assert.fail(), fallback).execute({ prompt: '鲸鱼' }, {signal:stopped.signal}));
    assert.equal(fallbackCalls, 1);
    await assert.rejects(imageGenerationTool({...config,dshImageFallback:false}, async () => assert.fail(), fallback).execute({prompt:'鲸鱼'},context));
    assert.equal(fallbackCalls, 1);
    await assert.rejects(imageGenerationTool(config, async () => assert.fail(), async () => {throw new Error('plugin failed');}).execute({prompt:'鲸鱼'},context), /plugin failed/);
  } finally {globalThis.__config=oldConfig;globalThis.fetch=oldFetch;}
});
