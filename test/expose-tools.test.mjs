import test from 'node:test';
import assert from 'node:assert/strict';
import { Expose, registerExpose, disposeExpose, getCurrentEvent, withEventContext } from 'alemonjs';
import { exposeModule } from '../lib/modules/expose.js';
import { executeTool } from '../lib/agent/modules.js';
import { startFrameworkMcp } from '../lib/platform/mcp.js';
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
const empty = { type: 'object', properties: {}, additionalProperties: false };
const event = { name: 'message.create', Platform: 'qq-bot', BotId: '900', ChannelId: '200', UserId: '100', IsPrivate: false };
const ctx = () => ({
  platform: 'qq-bot',
  botId: '900',
  channelId: '200',
  userId: '100',
  private: false,
  owner: false,
  requestId: 'turn',
  signal: new AbortController().signal,
  capabilities: { chat: true }
});
const fixture = fn =>
  runtimeScope.run({ resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now }, () =>
    withEventContext(event, () => {}, fn, { appName: 'alemonjs-agent-link' })
  );
const tools = (settings = {}) => {
  const list = [];
  exposeModule().setup({ settings, tool: tool => list.push(tool) });
  return Object.fromEntries(list.map(tool => [tool.name, tool]));
};
const args = (action = 'stats', input = '{}') => ({ protocol: 'game.v1', provider: 'game', action, argumentsJson: input });
const register = (effect = 'read', handler = async () => ({ hp: 42 }), authorize = () => true) =>
  registerExpose('game', [
    {
      name: 'game.v1',
      description: 'game',
      actions: {
        stats: Expose.action({
          description: '玩家状态',
          effect,
          inputSchema: empty,
          outputSchema: { type: 'object', properties: { hp: { type: 'integer' } }, required: ['hp'], additionalProperties: false },
          authorize,
          handler
        })
      }
    }
  ]);

test('discovers late providers and exact schemas, executes with real caller/event, rejects identity spoofing', () =>
  fixture(async () => {
    const t = tools();
    const c = ctx();
    assert.deepEqual((await executeTool(t.expose_discover, {}, c)).items, []);
    register('read', async (_input, context) => {
      assert.equal(context.callerApp, 'alemonjs-agent-link');
      assert.equal(getCurrentEvent().UserId, '100');
      return { hp: 42 };
    });
    assert.equal((await executeTool(t.expose_discover, {}, c)).items[0].callable, true);
    assert.deepEqual((await executeTool(t.expose_discover, { protocol: 'game.v1', provider: 'game', action: 'stats' }, c)).inputSchema, empty);
    assert.equal((await executeTool(t.expose_read, args(), c)).data.hp, 42);
    assert.equal((await executeTool(t.expose_read, args('stats', '{"uid":999}'), c)).error.code, 'INVALID_INPUT');
    await assert.rejects(executeTool(t.expose_read, args(), { ...c, userId: '999' }));
    await assert.rejects(executeTool(t.expose_read, args(), { ...c, autonomous: true }));
    disposeExpose('game');
    assert.equal((await executeTool(t.expose_read, args(), c)).error.outcome, 'not_started');
  }));

test('provider authorization/output contract govern automatically available writes', () =>
  fixture(async () => {
    let executions = 0;
    const c = ctx();
    const t = tools();
    register(
      'read',
      async () => {
        executions++;
        return { hp: 1 };
      },
      () => false
    );
    assert.equal((await executeTool(t.expose_read, args(), c)).error.code, 'FORBIDDEN');
    assert.equal(executions, 0);
    register('read', async () => ({ hp: 'bad' }));
    assert.equal((await executeTool(t.expose_read, args(), c)).error.code, 'INVALID_OUTPUT');
    register('write', async () => {
      executions++;
      return { hp: 2 };
    });
    assert.equal((await executeTool(t.expose_discover, {}, c)).items[0].callable, true);
    assert.equal((await executeTool(t.expose_read, args(), c)).error.code, 'EFFECT_MISMATCH');
    const write = t.expose_write;
    const first = await executeTool(write, args(), c);
    assert.deepEqual(await executeTool(write, args(), c), first);
    assert.equal(executions, 1);
    const filtered = tools({ providers: [] });
    assert.equal((await executeTool(filtered.expose_discover, {}, c)).items.length, 0);
  }));

test('MCP callback retains framework event and plugin identity for Expose', () =>
  fixture(async () => {
    register('read', async (_input, context) => {
      assert.equal(context.callerApp, 'alemonjs-agent-link');
      assert.equal(getCurrentEvent(), event);
      return { hp: 42 };
    });
    const bridge = await startFrameworkMcp(Object.values(tools()), ctx());
    try {
      const response = await fetch(bridge.endpoint.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { name: 'expose_read', argumentsJson: JSON.stringify(args()) } }
        })
      });
      const body = await response.json();
      assert.equal(JSON.parse(body.result.content[0].text).data.hp, 42);
    } finally {
      bridge.close();
    }
  }));

test('writes share receipts across MCP context copies and preserve unknown outcomes', () =>
  fixture(async () => {
    let executions = 0;
    register('write', async () => {
      executions++;
      throw new Error('provider private detail');
    });
    const write = tools().expose_write;
    const c = ctx();
    const [a, b] = await Promise.all([executeTool(write, args(), c), executeTool(write, args(), { ...c })]);
    assert.equal(executions, 1);
    assert.equal(a.error.outcome, 'unknown');
    assert.deepEqual(a, b);
    assert.ok(!JSON.stringify(a).includes('provider private detail'));
    const changed = await executeTool(write, args('stats', '{"new":1}'), { ...c });
    assert.equal(changed.error.code, 'DUPLICATE_WRITE');
    assert.equal(executions, 1);
  }));

test('incomplete contracts cannot execute; unknown effects require conservative entry and cancellation is bounded', () =>
  fixture(async () => {
    let executions = 0;
    const action = {
      description: 'legacy',
      effect: 'read',
      handler: () => {
        executions++;
        return {};
      }
    };
    registerExpose('legacy', [
      { name: 'legacy.v1', description: 'legacy', actions: Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`a${i}`, action])) }
    ]);
    const t = tools();
    const c = ctx();
    const first = await executeTool(t.expose_discover, {}, c);
    assert.equal(first.items.length, 30);
    assert.equal(first.nextOffset, 30);
    assert.equal(first.items[0].callable, false);
    assert.equal((await executeTool(t.expose_discover, { offset: 30 }, c)).items.length, 5);
    assert.equal((await executeTool(t.expose_read, { protocol: 'legacy.v1', provider: 'legacy', action: 'a0', argumentsJson: '{}' }, c)).ok, false);
    assert.equal(executions, 0);
    register('unknown', async () => {
      executions++;
      return { hp: 1 };
    });
    assert.equal((await executeTool(t.expose_read, args(), c)).ok, false);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(executeTool(t.expose_read, args(), { ...c, signal: controller.signal }));
    assert.equal(executions, 0);
    assert.throws(() => tools({ providers: [123] }));
  }));

test('unstarted argument errors allow correction; provider write denial remains authoritative without Link action settings', () =>
  fixture(async () => {
    let executions = 0;
    register('write', async () => {
      executions++;
      return { hp: 2 };
    });
    const t = tools();
    const c = ctx();
    const invalid = await executeTool(t.expose_write, args('stats', '{"extra":1}'), c);
    assert.equal(invalid.error.code, 'INVALID_INPUT');
    assert.equal(invalid.error.outcome, 'not_started');
    assert.equal((await executeTool(t.expose_write, args(), c)).ok, true);
    assert.equal(executions, 1);
    register(
      'write',
      async () => {
        executions++;
        return { hp: 3 };
      },
      () => false
    );
    const denied = await executeTool(t.expose_write, args(), { ...c, requestId: 'new-turn' });
    assert.equal(denied.error.code, 'FORBIDDEN');
    assert.equal(executions, 1);
  }));

test('mixed-speaker batching restores selected sender scope for Expose', () =>
  fixture(async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const { GroupConversationCoordinator } = await import('../lib/social/group-conversation.js');
    const { getGroupChatPolicy } = await import('../lib/social/group-policy.js');
    let scheduled;
    let observed;
    const coordinator = new GroupConversationCoordinator({
      random: () => 0,
      schedule: run => {
        const scope = AsyncLocalStorage.snapshot();
        scheduled = () => scope(run);
        return 1;
      },
      unschedule: () => {}
    });
    const policy = getGroupChatPolicy({ quietHours: [0, 0] });
    const t = tools();
    register('read', async () => {
      assert.equal(getCurrentEvent().UserId, '100');
      return { hp: 42 };
    });
    const message = (userId, direct) => ({
      channelId: '200',
      platform: 'qq-bot',
      id: userId,
      userId,
      userKey: userId,
      name: userId,
      owner: false,
      text: direct ? '肥鱼查我的属性' : '路过',
      direct,
      explicitMention: direct
    });
    const reply = async batch => {
      observed = { anchor: batch.anchor.userId, event: getCurrentEvent().UserId };
      assert.equal((await executeTool(t.expose_read, args(), ctx())).data.hp, 42);
      return { delivered: true };
    };
    const first = withEventContext(
      event,
      () => {},
      () => coordinator.receive(message('100', true), policy, reply),
      { appName: 'alemonjs-agent-link' }
    );
    const second = withEventContext(
      { ...event, UserId: 'other' },
      () => {},
      () => coordinator.receive(message('other', false), policy, reply),
      { appName: 'alemonjs-agent-link' }
    );
    scheduled();
    await Promise.all([first, second]);
    assert.deepEqual(observed, { anchor: '100', event: '100' });
  }));

test('query declared unknown is not reported as forbidden and can use conservative generic entry', () =>
  fixture(async () => {
    // Regression for the game's query() helper: get_profile/get_realm declare unknown.
    let queries = 0;
    register('unknown', async (_input, call) => {
      assert.equal(call.callerApp, 'alemonjs-agent-link');
      queries++;
      return { hp: 42 };
    });
    const t = tools();
    const c = ctx();
    const catalog = await executeTool(t.expose_discover, {}, c);
    assert.equal(catalog.items[0].callable, true);
    assert.equal(catalog.items[0].executionTool, 'expose_call');
    assert.equal(catalog.items[0].mayMutate, true);
    const schema = await executeTool(t.expose_discover, { protocol: 'game.v1', provider: 'game', action: 'stats' }, c);
    assert.equal(schema.effect, 'unknown');
    const wrong = await executeTool(t.expose_read, args(), c);
    assert.equal(wrong.error.code, 'EFFECT_MISMATCH');
    assert.equal(wrong.error.origin, 'link');
    assert.equal(wrong.executionTool, 'expose_call');
    assert.equal(queries, 0);
    const receipt = await executeTool(t.expose_call, args(), c);
    assert.equal(receipt.data.hp, 42);
    assert.deepEqual(await executeTool(t.expose_call, args(), { ...c }), receipt);
    assert.equal(queries, 1);
    await assert.rejects(executeTool(t.expose_call, args(), { ...c, autonomous: true }));
  }));

test('missing contract and provider denial carry distinct origins without declaring all reads unavailable', () =>
  fixture(async () => {
    const t = tools();
    const c = ctx();
    registerExpose('legacy', [{ name: 'legacy.v1', description: 'legacy', actions: { stats: { description: 'old read', handler: () => ({}) } } }]);
    const missing = await executeTool(t.expose_call, { ...args(), protocol: 'legacy.v1', provider: 'legacy' }, c);
    assert.equal(missing.error.code, 'CONTRACT_REQUIRED');
    assert.equal(missing.error.origin, 'link');
    register(
      'unknown',
      async () => {
        throw new Error('must not execute');
      },
      () => false
    );
    const rejected = await executeTool(t.expose_call, args(), c);
    assert.equal(rejected.error.code, 'FORBIDDEN');
    assert.equal(rejected.error.origin, 'expose');
    assert.ok(rejected.callId);
    assert.match(rejected.notice, /不能据此推断所有查询未开放/);
    const absent = await executeTool(t.expose_call, args('absent'), c);
    assert.equal(absent.error.code, 'CAPABILITY_NOT_FOUND');
  }));

test('capability search finds actions outside the first page without unrelated enumeration', () =>
  fixture(async () => {
    const action = { description: '无关动作', effect: 'read', inputSchema: empty, outputSchema: empty, handler: async () => ({}) };
    registerExpose('large-game', [
      {
        name: 'large.v1',
        description: 'large catalog',
        actions: {
          ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`other_${i}`, action])),
          get_profile: { ...action, description: '查询玩家资料与境界' }
        }
      }
    ]);
    const t = tools();
    const c = ctx();
    assert.equal((await executeTool(t.expose_discover, {}, c)).items.length, 30);
    const result = await executeTool(t.expose_discover, { query: '资料' }, c);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].action, 'get_profile');
    assert.equal(result.nextOffset, null);
    assert.equal((await executeTool(t.expose_discover, { query: 'GET_PROFILE' }, c)).items[0].action, 'get_profile');
  }));
