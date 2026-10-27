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
