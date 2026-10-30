import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { runCoordinatedChat, conversationQueueScope } from '../lib/dsh/orchestrator.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { setDSHBridgeForTesting, DSHSupervisor } from '../lib/dsh/supervisor.js';
import { runModuleTurn } from '../lib/agent/turn.js';

test('text model replies without waiting for a cold strict sandbox; workspace tool remains available for on-demand preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cold-sandbox-'));
  const original = { config: globalThis.__config, fetch: globalThis.fetch, prepare: DSHSupervisor.prototype.prepareForChat };
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'sandbox',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home')
      }
    }
  };
  const config = getDSHConfig();
  let prepared = false;
  let release;
  const preparation = new Promise(resolve => {
    release = resolve;
  });
  DSHSupervisor.prototype.prepareForChat = async function () {
    await preparation;
    prepared = true;
  };
  globalThis.fetch = async (_url, init) => {
    assert.equal(prepared, false);
    assert.ok(JSON.parse(init.body).tools.some(tool => tool.function.name === 'agent_workspace'));
    return Response.json({ choices: [{ message: { content: '先回复你的问题。' } }] });
  };
  const events = [];
  const controller = new AbortController();
  let timer;
  const turn = runModuleTurn({
    config,
    sessionId: 'cold-sandbox',
    input: '你在吗',
    context: {
      channelId: 'cold',
      platform: 'qq-bot',
      userId: 'one',
      private: false,
      owner: false,
      userText: '你在吗',
      capabilities: { chat: true, web: true, files: false, terminal: false },
      signal: controller.signal
    },
    onEvent: async event => {
      events.push(event);
    }
  });
  try {
    await Promise.race([
      turn,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ordinary chat waited for sandbox preparation')), 2000);
      })
    ]);
    assert.ok(events.some(event => event.type === 'content' && event.content.includes('先回复')));
    assert.equal(prepared, false);
  } finally {
    clearTimeout(timer);
    controller.abort();
    release();
    await turn.catch(() => undefined);
    await (await getModuleRuntime(config)).close();
    DSHSupervisor.prototype.prepareForChat = original.prepare;
    globalThis.fetch = original.fetch;
    globalThis.__config = original.config;
    await rm(root, { recursive: true, force: true });
  }
});

test('image turn without modules sends bytes to the model instead of DSH text projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-image-turn-'));
  const originalConfig = globalThis.__config;
  const originalFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'image-model',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        modules: { disabled: ['memory', 'chat-history', 'persona', 'mood', 'affinity', 'events', 'opinions'] }
      }
    }
  };
  const config = getDSHConfig();
  setDSHBridgeForTesting({ url: 'http://sandbox.test', token: 'test' });
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
    requests++;
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'image-model');
    assert.match(body.messages.find(item => item.role === 'system').content, /共用执行规则：按需使用工具/);
    assert.deepEqual(body.messages.at(-1).content, [
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cGljdHVyZQ==' } }
    ]);
    assert.ok(body.tools.some(tool => tool.function.name === 'agent_workspace'));
    return Response.json({ choices: [{ message: { content: '图片回复' } }] });
  };
  try {
    const events = [];
    await runModuleTurn({
      config,
      sessionId: 'image-test',
      input: [
        { type: 'text', text: '这是什么' },
        { type: 'image', mimeType: 'image/png', data: 'cGljdHVyZQ==' }
      ],
      context: {
        channelId: 'test',
        userId: 'one',
        platform: 'qq',
        private: false,
        owner: false,
        userText: '这是什么',
        capabilities: { chat: true, web: true, files: false, terminal: false },
        signal: new AbortController().signal
      },
      onEvent: async event => {
        events.push(event);
      }
    });
    assert.equal(requests, 1);
    assert.equal(events[0].content, '图片回复');
  } finally {
    await (await getModuleRuntime(config)).close();
    setDSHBridgeForTesting(null);
    globalThis.fetch = originalFetch;
    globalThis.__config = originalConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test('coordinated turn executes memory tools and stores the transformed reply only after delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-turn-'));
  const originalConfig = globalThis.__config;
  const originalFetch = globalThis.fetch;
  const userConfig = {
    apiKey: 'test',
    model: 'test',
    runtimeMode: 'chat-only',
    stateBackend: 'local',
    workspaceRoot: join(root, 'workspaces'),
    dshHomeRoot: join(root, 'homes')
  };
  globalThis.__config = { value: { 'alemonjs-agent-link': userConfig } };
  const config = getDSHConfig();
  const registry = new SessionRegistry(config);
  const channelId = 'private:one';
  const dir = join(root, 'modules', 'style');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.mjs'),
    `export default {id:'style',name:'表达',version:'1',apiVersion:1,setup(api){
    api.on('context', () => '按实际结果答复。');
    api.on('reply', text => text + ' 咕噜。');
  }};`
  );
  let modelCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    modelCalls++;
    assert.ok(JSON.stringify(body.messages).includes('按实际结果答复'));
    assert.ok(!body.tools.some(t => t.function.name === 'agent_workspace'));
    return Response.json({
      choices: [
        {
          message:
            modelCalls === 1
              ? {
                  content: null,
                  tool_calls: [{ id: 'save', type: 'function', function: { name: 'remember_private_fact', arguments: '{"text":"喜欢茶"}' } }]
                }
              : { content: '已经记住喜欢茶。' }
        }
      ]
    });
  };
  const event = { ChannelId: channelId, UserId: 'one', UserKey: 'one', IsPrivate: true, MessageId: 'first' };
  const content = [];
  let deliveryStarted;
  const started = new Promise(resolve => {
    deliveryStarted = resolve;
  });
  let deliver;
  const delivery = new Promise(resolve => {
    deliver = resolve;
  });
  try {
    const pending = runCoordinatedChat(
      event,
      '记住我喜欢茶',
      async event => {
        if (event.type === 'content') {
          content.push(event.content);
        }
      },
      undefined,
      undefined,
      undefined,
      async () => {
        deliveryStarted();
        await delivery;
      },
      { userText: '记住我喜欢茶' }
    );
    await started;
    const meta = await registry.meta(channelId);
    const history = { channelId, generation: meta.generation, scope: conversationQueueScope(config, { platform: event.Platform, botId: event.BotId }) };
    assert.deepEqual(await registry.privateHistory(history), []);
    assert.equal((await registry.privateMemories(channelId, history.scope))[0].text, '喜欢茶');
    deliver();
    const result = await pending;
    await result.confirmDelivery();
    assert.deepEqual(content, ['已经记住喜欢茶。 咕噜。']);
    assert.equal((await registry.privateHistory(history)).at(-1).content, content[0]);
    assert.equal((await runCoordinatedChat(event, '重复消息', async () => assert.fail('duplicate sent'))).duplicate, true);
    const previousTurns = await registry.privateHistory(history);
    await assert.rejects(
      runCoordinatedChat(
        { ...event, MessageId: 'failed' },
        '你好',
        async () => {},
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error('platform failed');
        },
        { userText: '你好' }
      ),
      /platform failed/
    );
    assert.deepEqual(await registry.privateHistory(history), previousTurns);
  } finally {
    deliver();
    await (await getModuleRuntime(config)).close();
    globalThis.fetch = originalFetch;
    globalThis.__config = originalConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test('business model delegates workspace actions through the authenticated sandbox and uses its actual result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-'));
  const originalConfig = globalThis.__config;
  const originalFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'sandbox',
        stateBackend: 'local',
        workspaceRoot: join(root, 'workspaces'),
        dshHomeRoot: join(root, 'homes')
      }
    }
  };
  const config = getDSHConfig();
  setDSHBridgeForTesting({ url: 'http://sandbox.test', token: 'bridge-test-token' });
  let modelCalls = 0;
  let delegated = 0;
  globalThis.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (String(url).startsWith('http://sandbox.test/')) {
      assert.equal(init.headers.Authorization, 'Bearer bridge-test-token');
      if (init.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      delegated++;
      assert.deepEqual(body.capabilities, { chat: true, web: true, files: false, terminal: false });
      assert.equal(body.message, '查询天气');
      assert.match(body.systemPrompt, /共用执行规则：按需使用工具/);
      return new Response('data: {"type":"content","content":"查询结果：晴"}\n\ndata: {"type":"done"}\n\n', {
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    modelCalls++;
    assert.ok(body.tools.some(t => t.function.name === 'agent_workspace'));
    if (modelCalls === 1) {
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'workspace',
                  type: 'function',
                  function: { name: 'agent_workspace', arguments: '{"task":"查询天气"}' }
                }
              ]
            }
          }
        ]
      });
    }
    assert.deepEqual(JSON.parse(body.messages.find(m => m.role === 'tool').content), { ok: true, result: '查询结果：晴' });
    return Response.json({ choices: [{ message: { content: '查到了，今天晴。' } }] });
  };
  try {
    const content = [];
    const result = await runCoordinatedChat(
      { ChannelId: 'private:weather', UserId: 'one', MessageId: 'weather' },
      '天气如何',
      async event => {
        if (event.type === 'content') {
          content.push(event.content);
        }
      },
      undefined,
      undefined,
      { version: 1, chat: true, web: true, files: false, terminal: false },
      async () => {}
    );
    await result.confirmDelivery();
    assert.equal(delegated, 1);
    assert.deepEqual(content, ['查到了，今天晴。']);
  } finally {
    await (await getModuleRuntime(config)).close();
    setDSHBridgeForTesting(null);
    globalThis.fetch = originalFetch;
    globalThis.__config = originalConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test('drawing request exposes a real render tool and queues a PNG before final reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-draw-turn-'));
  const oldConfig = globalThis.__config,
    oldFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        budget: { enabled: false },
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        modules: { disabled: ['memory', 'chat-history', 'persona', 'mood', 'affinity', 'events', 'opinions'] }
      }
    }
  };
  const config = getDSHConfig();
  setDSHBridgeForTesting({ url: 'http://sandbox.test', token: 'test' });
  let calls = 0,
    queued;
  const events = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.tools.some(tool => tool.function.name === 'draw_image'));
    calls++;
    if (calls === 1)
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'draw-1',
                  type: 'function',
                  function: {
                    name: 'draw_image',
                    arguments: JSON.stringify({ width: 128, height: 128, elements: [{ type: 'circle', x: 64, y: 64, radius: 40, fill: '#4098da' }] })
                  }
                }
              ]
            }
          }
        ]
      });
    assert.ok(queued);
    assert.equal(JSON.parse(body.messages.at(-1).content).created, true);
    return Response.json({ choices: [{ message: { content: '画好了。' } }] });
  };
  try {
    await runModuleTurn({
      config,
      sessionId: 'draw',
      input: '画一个蓝色圆形图标',
      context: {
        channelId: 'group',
        platform: 'qq',
        userId: 'u',
        private: false,
        owner: false,
        userText: '画图',
        capabilities: { chat: true, web: false, files: false, terminal: false },
        signal: new AbortController().signal
      },
      onImage: async png => {
        queued = png;
      },
      onEvent: async event => {
        events.push(event);
      }
    });
    assert.equal(calls, 2);
    assert.equal(queued.readUInt32BE(16), 128);
    assert.equal(events.find(event => event.type === 'content').content, '画好了。');
  } finally {
    await (await getModuleRuntime(config)).close();
    setDSHBridgeForTesting(null);
    globalThis.__config = oldConfig;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});
