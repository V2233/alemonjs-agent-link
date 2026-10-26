import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { runCoordinatedChat } from '../lib/dsh/orchestrator.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { setDSHBridgeForTesting } from '../lib/dsh/supervisor.js';

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
    const history = { channelId, generation: meta.generation };
    assert.deepEqual(await registry.privateHistory(history), []);
    assert.equal((await registry.privateMemories(channelId))[0].text, '喜欢茶');
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
