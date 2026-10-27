import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { startFrameworkMcp } from '../lib/platform/mcp.js';

const context = () => ({
  platform: 'onebot',
  botId: '900',
  channelId: '200',
  userId: '100',
  private: false,
  owner: false,
  capabilities: { chat: true },
  signal: new AbortController().signal
});
const rpc = async (bridge, method, params, token = bridge.endpoint.token) => {
  const response = await fetch(bridge.endpoint.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return response.status === 200 ? (await response.json()).result : response.status;
};
const decoded = result => JSON.parse(result.content[0].text);

test('MCP discovers only permitted tools, returns schema on demand and executes in original async scope', async () => {
  const scope = new AsyncLocalStorage();
  let executed = 0;
  let allowed = true;
  const tool = {
    name: 'group_info',
    description: '群资料',
    readOnly: true,
    available: () => allowed,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_args, ctx) => {
      executed++;
      assert.equal(scope.getStore(), 'framework-runtime');
      assert.equal(ctx.channelId, '200');
      return { memberCount: 42 };
    }
  };
  const bridge = await scope.run('framework-runtime', () =>
    startFrameworkMcp([tool, { ...tool, name: 'secret', available: () => false }, { ...tool, name: 'agent_workspace' }], context())
  );
  try {
    assert.equal(await rpc(bridge, 'tools/list', {}, 'wrong'), 403);
    assert.equal((await rpc(bridge, 'initialize', {})).serverInfo.name, 'agent-link-framework');
    assert.deepEqual(
      (await rpc(bridge, 'tools/list')).tools.map(tool => tool.name),
      ['discover', 'call']
    );
    const catalog = decoded(await rpc(bridge, 'tools/call', { name: 'discover' }));
    assert.deepEqual(
      catalog.capabilities.map(tool => tool.name),
      ['group_info']
    );
    assert.equal(catalog.capabilities[0].parameters, undefined);
    assert.deepEqual(decoded(await rpc(bridge, 'tools/call', { name: 'discover', arguments: { name: 'group_info' } })).parameters, tool.parameters);
    assert.equal(decoded(await rpc(bridge, 'tools/call', { name: 'call', arguments: { name: 'group_info', argumentsJson: '{}' } })).memberCount, 42);
    assert.equal((await rpc(bridge, 'tools/call', { name: 'call', arguments: { name: 'group_info', argumentsJson: '{"groupId":"999"}' } })).isError, true);
    allowed = false;
    assert.equal((await rpc(bridge, 'tools/call', { name: 'call', arguments: { name: 'group_info', argumentsJson: '{}' } })).isError, true);
    assert.equal(executed, 1);
  } finally {
    bridge.close();
  }
  await assert.rejects(fetch(bridge.endpoint.url));
});

test('MCP sessions isolate context, suppress recursive tools and revoke on cancellation', async () => {
  const controller = new AbortController();
  const tool = { name: 'current', readOnly: true, description: '', parameters: { type: 'object' }, execute: async (_args, ctx) => ctx.channelId };
  const a = await startFrameworkMcp([tool], { ...context(), signal: controller.signal });
  const b = await startFrameworkMcp([tool], { ...context(), channelId: '201' });
  try {
    const call = { name: 'call', arguments: { name: 'current', argumentsJson: '{}' } };
    assert.equal(decoded(await rpc(a, 'tools/call', call)), '200');
    assert.equal(decoded(await rpc(b, 'tools/call', call)), '201');
    assert.equal(await rpc(b, 'tools/call', call, a.endpoint.token), 403);
    controller.abort();
    await assert.rejects(fetch(a.endpoint.url));
  } finally {
    a.close();
    b.close();
  }
});

test('DSH client includes the scoped callback only when supplied', async () => {
  const { streamChat, getDSHConfig } = await import('../lib/dsh/client.js');
  const { setDSHBridgeForTesting } = await import('../lib/dsh/supervisor.js');
  const original = globalThis.fetch;
  const previousConfig = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { aiEnabled: true } } };
  const captured = [];
  setDSHBridgeForTesting({ url: 'http://dsh.test', token: 'fixture' });
  globalThis.fetch = async (_url, options) => {
    captured.push(JSON.parse(options.body));
    return new Response('data: {"type":"done"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const endpoint = { url: 'http://127.0.0.1:1234/mcp', token: 'a'.repeat(64) };
    const args = [getDSHConfig({}), 'dsh:qq:group:1', 'hello', async () => {}, '100', undefined, { chat: true, web: false, files: false, terminal: false }];
    await streamChat(...args, undefined, undefined, endpoint);
    await streamChat(...args);
    assert.deepEqual(captured[0].framework, endpoint);
    assert.equal(Object.hasOwn(captured[1], 'framework'), false);
  } finally {
    globalThis.fetch = original;
    setDSHBridgeForTesting(undefined);
    globalThis.__config = previousConfig;
  }
});
