import assert from 'node:assert/strict';
import test from 'node:test';
import { DSHError, clearSession, getDSHConfig, purgeSessionData, streamChat, toUserMessage } from '../lib/dsh/client.js';
import { StreamOutput } from '../lib/dsh/output.js';
import { buildRecentChatContext, clearRecentMessages, compressRecentMessages, getRecentMessages, recordRecentMessage } from '../lib/chat-context/store.js';
import { canReset, extractPrompt, getSessionId } from '../lib/response/dsh/util.js';
import { defaultGroupPolicy, ownerPrivatePolicy } from '../lib/state/registry.js';
import { setDSHBridgeForTesting } from '../lib/dsh/supervisor.js';
import { listAvailableModels } from '../lib/dsh/models.js';
import { getDedupeTtlSeconds } from '../lib/state/registry.js';

const encoder = new TextEncoder();

const sseResponse = (...chunks) =>
  new Response(
    new ReadableStream({
      start(controller) {
        chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      }
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );

const config = {
  pythonExecutable: 'python3',
  bridgePort: 18080,
  workspaceRoot: '/tmp/workspaces',
  dshHomeRoot: '/tmp/dsh-homes',
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  defaultSystemPrompt: 'test prompt',
  maxMessageLength: 3,
  streamFlushIntervalMs: 10000,
  requestTimeoutMs: 1000
};

setDSHBridgeForTesting({ url: 'http://dsh.test', token: 'secret' });

test('startup diagnostics are specific and do not claim a session was reset', () => {
  const detail = 'DSH 初始化失败，自动恢复后仍不可用，请检查本地运行环境。';
  assert.equal(toUserMessage(new DSHError('agent', detail)), detail);
  const generic = toUserMessage(new DSHError('agent', 'private provider detail'));
  assert.doesNotMatch(generic, /private provider detail|已自动开始/);
});

test('accepts default and bounded request timeouts, rejecting invalid values', () => {
  assert.equal(getDSHConfig({}).requestTimeoutMs, 120000);
  for (const requestTimeoutMs of [1, 120000, 300000]) {
    assert.equal(getDSHConfig({ 'alemonjs-agent-link': { requestTimeoutMs } }).requestTimeoutMs, requestTimeoutMs);
  }
  for (const requestTimeoutMs of [0, -1, 300001, 1.5, '120000', null]) {
    assert.throws(() => getDSHConfig({ 'alemonjs-agent-link': { requestTimeoutMs } }), /DSH 配置/);
  }
});

test('reads credentials exclusively from AgentLink configuration', async () => {
  const { getDSHCredentials, saveDSHCredentials } = await import('../lib/dsh/credentials.js');
  assert.deepEqual(
    await getDSHCredentials({
      'alemonjs-agent-link': { apiKey: 'configured-secret', baseUrl: 'https://models.example/v1' }
    }),
    { apiKey: 'configured-secret', baseUrl: 'https://models.example/v1' }
  );
  assert.equal(await getDSHCredentials({ 'alemonjs-agent-link': {} }), null);
  await assert.rejects(() => saveDSHCredentials({ apiKey: 'replacement' }), /alemon.config.yaml/);
});

test('sends a DSH SSE request and consumes content events', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return sseResponse('data: {"type":"content","content":"你"}\n\n', 'data: {"type":"content","content":"好"}\n\ndata: {"type":"done"}\n\n');
  };

  const events = [];
  await streamChat(config, 'dsh:qq:group:1', 'hello', async event => events.push(event));
  globalThis.fetch = originalFetch;

  assert.equal(request.url, 'http://dsh.test/v1/chat');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(request.options.body), {
    sessionId: 'dsh:qq:group:1',
    message: 'hello',
    systemPrompt: 'test prompt',
    stream: true,
    capabilities: { chat: true, web: true, files: false, terminal: false }
  });
  assert.deepEqual(events, [{ type: 'content', content: '你' }, { type: 'content', content: '好' }, { type: 'done' }]);
});

test('sends only the Bridge capability schema, never policy metadata', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = options;
    return sseResponse('data: {"type":"done"}\n\n');
  };

  await streamChat(config, 'dsh:qq:group:1', 'hello', async () => {}, 'owner', undefined, { version: 1, chat: true, web: true, files: false, terminal: false });
  globalThis.fetch = originalFetch;
  assert.deepEqual(JSON.parse(request.body).capabilities, { chat: true, web: true, files: false, terminal: false });
});

test('maps DSH HTTP and protocol failures to safe user messages', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 401 });
  await assert.rejects(
    () => streamChat(config, 's', 'm', async () => {}),
    error => error instanceof DSHError && error.kind === 'auth'
  );
  globalThis.fetch = async () => sseResponse('data: not-json\n\n');
  await assert.rejects(
    () => streamChat(config, 's', 'm', async () => {}),
    error => error instanceof DSHError && error.kind === 'protocol'
  );
  globalThis.fetch = originalFetch;

  assert.equal(toUserMessage(new DSHError('auth', 'x')), 'Agent 服务认证失败，请联系机器人管理员。');
  assert.equal(toUserMessage(new DSHError('network', 'x')), '暂时无法连接 Agent 服务，请稍后再试。');
});

test('clears an encoded group session through the DSH API', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  };

  await clearSession(config, 'dsh:qq:group:a/b');
  globalThis.fetch = originalFetch;
  assert.equal(request.url, 'http://dsh.test/v1/session/dsh%3Aqq%3Agroup%3Aa%2Fb');
  assert.equal(request.options.method, 'DELETE');
});

test('times out a stalled destructive bridge request', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) =>
    await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

  // The real socket keeps Node alive; the mocked fetch needs an equivalent handle.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      () => purgeSessionData({ ...config, requestTimeoutMs: 10 }, 'dsh:qq:group:stalled'),
      error => error instanceof DSHError && error.kind === 'timeout'
    );
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = originalFetch;
  }
});

test('streams independently renderable Markdown units without splitting code fences', async () => {
  const sent = [];
  const output = new StreamOutput(
    async text => sent.push(text),
    64,
    10000,
    () => assert.fail('send should not fail')
  );

  output.append('先到。');
  await output.flush();
  assert.deepEqual(sent, ['先到。']);

  output.append('```ts\nconst answer = 42;\n');
  await output.flush();
  assert.deepEqual(sent, ['先到。']);

  output.append('```\n\n后续内容');
  await output.flush();
  assert.deepEqual(sent, ['先到。', '```ts\nconst answer = 42;\n```\n\n']);

  assert.equal(await output.close(), true);
  assert.deepEqual(sent, ['先到。', '```ts\nconst answer = 42;\n```\n\n', '后续内容']);
});

test('derives shared group sessions, strips a leading bot mention, and guards reset', () => {
  assert.equal(getSessionId('group-7'), 'dsh:qq:group:group-7');
  assert.equal(getSessionId('private:owner-7'), 'dsh:qq:private:owner-7');
  assert.equal(extractPrompt('<@bot-1> 你好', { UserId: 'bot-1' }), '你好');
  assert.equal(extractPrompt('@机器人 /new', { UserId: 'bot-1', UserName: '机器人' }), '/new');
  assert.equal(canReset({ IsMaster: true }), true);
  assert.equal(canReset({ IsMaster: false, IsAdmin: true }), true);
  assert.equal(canReset({ IsMaster: false }), false);
  assert.throws(() => getDSHConfig({ 'alemonjs-agent-link': { maxMessageLength: 0 } }));
  assert.throws(() => getDSHConfig({ 'alemonjs-agent-link': { maxConcurrentRequests: 0 } }));
  assert.throws(() => getDSHConfig({ 'alemonjs-agent-link': { maxActiveWorkers: 201 } }));
});

test('defaults groups to web access while owner private sessions receive all tools', () => {
  assert.deepEqual(defaultGroupPolicy, { version: 1, chat: true, web: true, files: false, terminal: false });
  assert.deepEqual(ownerPrivatePolicy, { version: 1, chat: true, web: true, files: true, terminal: true });
});

test('keeps idempotency claims alive through the maximum group queue', () => {
  assert.equal(getDedupeTtlSeconds({ maxQueuedPerGroup: 3, requestTimeoutMs: 120_000 }), 1020);
  assert.equal(getDedupeTtlSeconds({ maxQueuedPerGroup: 3, requestTimeoutMs: 300_000 }), 1740);
});

test('compresses recent chat before it is provided to DSH', () => {
  const messages = [
    { text: '随意闲聊', timestamp: 1 },
    { text: '决定明天十点发布，请确认负责人。', timestamp: 2 },
    { text: '随意闲聊', timestamp: 3 },
    { text: '最后一条最新消息', timestamp: 4 }
  ];

  const compressed = compressRecentMessages(messages, 24);
  assert.ok(compressed.some(item => item.text.includes('决定')));
  assert.ok(compressed.some(item => item.text.includes('最后')));
  assert.ok(compressed.reduce((size, item) => size + item.text.length, 0) <= 24);
  assert.match(buildRecentChatContext(messages, 24), /本地压缩摘录/);
});

test('lists models through the bound provider without exposing the API key', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return Response.json({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] });
  };

  const models = await listAvailableModels({ apiKey: 'secret', baseUrl: 'https://models.example/v1/' });
  globalThis.fetch = originalFetch;

  assert.equal(request.url, 'https://models.example/v1/models');
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  assert.deepEqual(models, ['deepseek-chat', 'deepseek-reasoner']);
});

test('bridge completion awaits delivery and preserves delivery failures', async () => {
  const originalFetch = globalThis.fetch;
  const order = [];
  globalThis.fetch = async () => sseResponse('data: {"type":"content","content":"hi"}\n\ndata: {"type":"done"}\n\n');
  try {
    await streamChat(
      config,
      's',
      'm',
      async event => {
        order.push(event.type);
      },
      'owner',
      undefined,
      undefined,
      undefined,
      async signal => {
        assert.equal(signal.aborted, false);
        order.push('delivered');
      }
    );
    assert.deepEqual(order, ['content', 'done', 'delivered']);
    await assert.rejects(
      streamChat(
        config,
        's',
        'm',
        async () => {},
        'owner',
        undefined,
        undefined,
        undefined,
        async () => {
          throw new DSHError('delivery', 'failed');
        }
      ),
      error => error.kind === 'delivery'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sandbox receives current explicit memory as reference alongside the actual request', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return sseResponse('data: {"type":"done"}\n\n');
  };
  try {
    await streamChat(config, 's', '今天聊什么', async () => {}, 'u', undefined, undefined, {
      channelId: 'private:test',
      generation: 1,
      memoryContext: '明确保存：喜欢科幻'
    });
    assert.equal(body.message, '明确保存：喜欢科幻\n\n当前消息：\n今天聊什么');
    assert.equal(body.systemPrompt, config.defaultSystemPrompt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sandbox bridge forwards image bytes as ACP blocks with memory intact', async () => {
  const originalFetch = globalThis.fetch;
  const blocks = [
    { type: 'text', text: '这是什么' },
    { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
  ];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.message.slice(1), blocks);
    assert.equal(body.message[0].text, '明确保存的记忆');
    return sseResponse('data: {"type":"done"}\n\n');
  };
  try {
    await streamChat(config, 's', blocks, async () => {}, 'u', undefined, undefined, {
      channelId: 'private:test',
      generation: 1,
      memoryContext: '明确保存的记忆'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
