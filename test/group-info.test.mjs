import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultCode } from 'alemonjs';
import { currentGroupInfo } from '../lib/platform/client.js';
import { OneBotActions } from '../lib/onebot/actions.js';
import { runToolChat } from '../lib/agent/tool-chat.js';
import { getDSHConfig } from '../lib/dsh/client.js';
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
const context = {
  platform: 'qq-bot',
  botId: '900',
  channelId: '200',
  userId: '100',
  private: false,
  owner: false,
  capabilities: { chat: true },
  signal: new AbortController().signal
};
const scope = action => ({ resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, action });

test('group lookup uses the trusted current group and preserves missing vs zero counts', async () => {
  for (const memberCount of [17, 0, undefined, '17', -1]) {
    await runtimeScope.run(
      scope(async frame => {
        assert.equal(frame.action, 'guild.info');
        assert.equal(frame.payload.GuildId, '200');
        assert.equal(frame.payload.BotId, '900');
        return [{ code: ResultCode.Ok, data: { GuildId: '200', GuildName: '测试群', MemberCount: memberCount } }];
      }),
      async () => {
        const result = await currentGroupInfo(context);
        assert.equal(result.name, '测试群');
        assert.equal(result.memberCount, typeof memberCount === 'number' && memberCount >= 0 ? memberCount : null);
      }
    );
  }
  await assert.rejects(currentGroupInfo({ ...context, private: true }));
  await runtimeScope.run(
    scope(async () => [{ code: ResultCode.Fail, data: null }]),
    async () => assert.equal((await currentGroupInfo(context)).ok, false)
  );
  await runtimeScope.run(
    scope(async () => [{ code: ResultCode.Ok, data: { GuildId: 'other' } }]),
    async () => assert.rejects(currentGroupInfo(context))
  );
});

test('OneBot maps the standard guild.info action to a scoped live group query', async () => {
  const calls = [];
  const actions = new OneBotActions(
    {
      config: { selfId: '900' },
      call: async (method, args) => {
        calls.push({ method, args });
        return { group_id: 200, group_name: '群名', member_count: 42 };
      }
    },
    () => ({ owner: () => false, groups: [], disabled: [] })
  );
  const event = { Platform: 'onebot', BotId: '900', ChannelId: '200', UserId: '100', IsPrivate: false };
  const [result] = await actions.action({ action: 'guild.info', payload: { event, GuildId: '200' } });
  assert.equal(result.code, ResultCode.Ok);
  assert.deepEqual(result.data, { GuildId: '200', GuildName: '群名', MemberCount: 42 });
  assert.deepEqual(calls, [{ method: 'get_group_info', args: { group_id: 200, no_cache: true } }]);
  const [denied] = await actions.action({ action: 'guild.info', payload: { event, GuildId: '999' } });
  assert.notEqual(denied.code, ResultCode.Ok);
  assert.equal(calls.length, 1);
});

test('model tool loop can query framework group information and consume the real receipt', async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (++calls === 1)
      return Response.json({
        choices: [{ message: { tool_calls: [{ id: 'info', type: 'function', function: { name: 'get_current_group_info', arguments: '{}' } }] } }]
      });
    const info = JSON.parse(body.messages.at(-1).content);
    assert.equal(info.name, '测试群');
    assert.equal(info.memberCount, 42);
    return Response.json({ choices: [{ message: { content: '这个群叫测试群，目前42人。' } }] });
  };
  try {
    await runtimeScope.run(
      scope(async () => [{ code: ResultCode.Ok, data: { GuildId: '200', GuildName: '测试群', MemberCount: 42 } }]),
      async () => {
        const result = await runToolChat({
          config: getDSHConfig({ model: 'test' }),
          credentials: { apiKey: 'test' },
          input: '这个群有几个人',
          context,
          maxRounds: 2,
          tools: createFrameworkTools()
        });
        assert.equal(result, '这个群叫测试群，目前42人。');
        assert.equal(calls, 2);
      }
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

const { createFrameworkTools } = await import('../lib/platform/catalog.js');
const { platformModule } = await import('../lib/modules/platform.js');

test('platform module registers generated capabilities; direct execution enforces schema, platform and scope', async () => {
  const registered = [];
  platformModule(getDSHConfig({})).setup({ tool: tool => registered.push(tool) });
  for (const tool of createFrameworkTools()) {
    assert.ok(registered.some(item => item.name === tool.name));
    assert.equal(tool.available({ ...context, private: true }), false);
    await assert.rejects(tool.execute({}, { ...context, platform: 'unsupported' }));
    await assert.rejects(tool.execute({ groupId: '999' }, context));
    await assert.rejects(tool.execute({}, { ...context, private: true }));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(tool.execute({}, { ...context, signal: controller.signal }));
  }
  assert.throws(() => createFrameworkTools([{ name: 'a' }, { name: 'a' }]));
});

test('member tools bind current group, project fields and preserve unknown pagination', async () => {
  const tools = createFrameworkTools();
  const info = tools.find(tool => tool.name === 'get_current_group_member');
  const list = tools.find(tool => tool.name === 'list_current_group_members');
  await runtimeScope.run(
    scope(async frame => {
      assert.equal(frame.payload.event.GuildId, '200');
      assert.equal(frame.payload.BotId, '900');
      if (frame.action === 'member.info') {
        assert.deepEqual(frame.payload.params, { userId: '100', guildId: '200' });
        return [{ code: ResultCode.Ok, data: { UserId: '100', GuildId: '200', Nickname: '主人', Role: 'member', UnionId: 'private-value' } }];
      }
      assert.equal(frame.action, 'member.list');
      assert.deepEqual(frame.payload.params, { Limit: 100, Cursor: 'opaque' });
      return [{ code: ResultCode.Ok, data: { Items: Array.from({ length: 101 }, (_, i) => ({ UserId: String(i), GuildId: '200' })) } }];
    }),
    async () => {
      assert.deepEqual((await info.execute({}, context)).member, { userId: '100', name: '主人', role: 'member' });
      const page = await list.execute({ cursor: 'opaque' }, context);
      assert.equal(page.members.length, 100);
      assert.equal(page.truncated, true);
      assert.equal(page.hasMore, null);
      assert.equal(page.nextCursor, null);
    }
  );
  await runtimeScope.run(
    scope(async () => [{ code: ResultCode.Ok, data: { UserId: '999', GuildId: '200' } }]),
    async () => assert.rejects(info.execute({}, context))
  );
  await runtimeScope.run(
    scope(async () => [{ code: ResultCode.Fail, data: null }]),
    async () => assert.equal((await list.execute({}, context)).ok, false)
  );
});

test('generated tools reach OneBot member adapters with bounded pages and reject mismatched identity', async () => {
  let calls = 0;
  let wrongUser = false;
  const actions = new OneBotActions(
    {
      config: { selfId: '900' },
      call: async (method, args) => {
        calls++;
        assert.equal(args.group_id, 200);
        if (method === 'get_group_member_info') return { group_id: 200, user_id: wrongUser ? 999 : args.user_id, nickname: '柠檬', role: 'member' };
        assert.equal(method, 'get_group_member_list');
        return Array.from({ length: 105 }, (_, i) => ({ group_id: 200, user_id: 100 + i, nickname: `成员${i}` }));
      }
    },
    () => ({ owner: () => false, groups: [], disabled: [] })
  );
  const ctx = { ...context, platform: 'onebot' };
  const tools = createFrameworkTools();
  await runtimeScope.run(
    scope(frame => actions.action(frame)),
    async () => {
      const info = tools.find(tool => tool.name === 'get_current_group_member');
      assert.equal((await info.execute({}, ctx)).member.name, '柠檬');
      wrongUser = true;
      assert.equal((await info.execute({}, ctx)).ok, false);
      const list = tools.find(tool => tool.name === 'list_current_group_members');
      const first = await list.execute({}, ctx);
      assert.equal(first.members.length, 100);
      assert.equal(first.nextCursor, '100');
      assert.equal(first.hasMore, true);
      const second = await list.execute({ cursor: first.nextCursor }, ctx);
      assert.equal(second.members.length, 5);
      assert.equal(second.hasMore, false);
      const before = calls;
      assert.equal((await list.execute({ cursor: '-1' }, ctx)).ok, false);
      assert.equal(calls, before);
    }
  );
});
