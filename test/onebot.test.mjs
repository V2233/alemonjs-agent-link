import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { ResultCode, getConfig } from 'alemonjs';
import { resolveOneBotConfig } from '../lib/onebot/config.js';
import { OneBotConnection, OneBotError } from '../lib/onebot/connection.js';
import { normalizeOneBotEvent, parseSegments } from '../lib/onebot/events.js';
import { OneBotActions, formatSegments } from '../lib/onebot/actions.js';
import { PlatformLedger } from '../lib/platform/ledger.js';
import { PlatformOperationError } from '../lib/platform/client.js';
import { claimPoke } from '../lib/social/poke.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { runModuleTurn } from '../lib/agent/turn.js';
import { inspectConfig } from '../bin/startup.mjs';
import { fork } from 'node:child_process';
import { launchRuntime } from '../bin/runtime.mjs';

const owner = id => id === '100';
const raw = {
  post_type: 'message',
  message_type: 'group',
  self_id: 900,
  group_id: 200,
  user_id: 100,
  message_id: 10,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: '主人', role: 'member' },
  message: [{ type: 'text', data: { text: '你好' } }]
};
const event = normalizeOneBotEvent(raw, '900', owner);
const context = {
  platform: 'onebot',
  botId: '900',
  channelId: '200',
  userId: '100',
  requestId: 'r',
  inputId: '10',
  private: false,
  owner: true,
  userText: '禁言300十秒',
  capabilities: { chat: true, web: false, files: false, terminal: false },
  signal: new AbortController().signal
};
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'onebot-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const serverFixture = async run => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const config = resolveOneBotConfig({ onebot: { url: `ws://127.0.0.1:${server.address().port}`, selfId: '900', accessToken: 'test', timeoutMs: 200 } });
  let connection;
  try {
    await run({ server, config, connect: handlers => (connection = new OneBotConnection(config, handlers)) });
  } finally {
    connection?.stop();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  }
};
const waitFor = async condition => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await sleep(5);
  }
  assert.fail('condition did not become true');
};

test('OneBot config validates transport credentials without echoing secrets and CLI doctor does not demand QQ Bot AppID', () => {
  const config = { onebot: { url: 'ws://127.0.0.1:3001', selfId: '900' }, 'alemonjs-agent-link': { transport: 'onebot', apiKey: 'test' } };
  assert.equal(resolveOneBotConfig(config).selfId, '900');
  assert.ok(inspectConfig(config, {}).every(check => check.status !== 'error'));
  for (const onebot of [
    { url: 'ws://remote.test', selfId: '900', accessToken: 'secret' },
    { url: 'wss://remote.test', selfId: '900' },
    { url: 'ws://secret:secret@localhost/', selfId: '900' },
    { url: 'ws://127.0.0.1/?token=secret', selfId: '900' },
    { url: 'ws://127.0.0.1/', selfId: 900 },
    { url: 'ws://127.0.0.1/', selfId: '900', accessToken: 'secret\ninvalid' }
  ])
    assert.throws(
      () => resolveOneBotConfig({ onebot }),
      error => !error.message.includes('secret')
    );
});

test('real WebSocket verifies account before accepting events and correlates successful, rejected and timed-out requests', () =>
  serverFixture(async ({ server, config, connect }) => {
    const events = [],
      requests = [];
    let peer;
    server.on('connection', (socket, request) => {
      peer = socket;
      assert.equal(request.headers.authorization, 'Bearer test');
      socket.send(JSON.stringify(raw)); // Cannot arrive before verified login.
      socket.on('message', bytes => {
        const frame = JSON.parse(bytes.toString());
        requests.push(frame);
        if (frame.action === 'hang') return;
        if (frame.action === 'reject') socket.send(JSON.stringify({ echo: frame.echo, status: 'failed', retcode: 1403, wording: 'sensitive detail' }));
        else
          socket.send(
            JSON.stringify({ echo: frame.echo, status: 'ok', retcode: 0, data: frame.action === 'get_login_info' ? { user_id: 900 } : { message_id: 55 } })
          );
      });
    });
    const connection = connect({ event: value => events.push(value) });
    connection.start();
    await waitFor(() => connection.status().state === 'ready');
    assert.equal(events.length, 0);
    peer.send(JSON.stringify({ ...raw, self_id: 999 }));
    peer.send(JSON.stringify(raw));
    await waitFor(() => events.length === 1);
    assert.deepEqual(await connection.call('send_group_msg', { group_id: 200, message: [] }), { message_id: 55 });
    await assert.rejects(connection.call('reject'), error => error.kind === 'rejected' && error.retcode === 1403 && !error.message.includes('sensitive'));
    await assert.rejects(connection.call('hang'), error => error.kind === 'timeout');
    assert.equal(requests.filter(frame => frame.action === 'hang').length, 1, 'writes are never automatically retried');
    assert.equal(connection.config.timeoutMs, config.timeoutMs);
  }));

test('wrong login identity never becomes ready and disconnect rejects pending operations before reconnecting', () =>
  serverFixture(async ({ server, connect }) => {
    let wrong = true,
      socketCount = 0,
      pending;
    server.on('connection', socket => {
      socketCount++;
      socket.on('message', bytes => {
        const frame = JSON.parse(bytes.toString());
        if (frame.action === 'get_login_info')
          socket.send(JSON.stringify({ echo: frame.echo, status: 'ok', retcode: 0, data: { user_id: wrong ? 999 : 900 } }));
        else {
          pending = frame;
          socket.terminate();
        }
      });
    });
    const events = [];
    const connection = connect({ event: value => events.push(value), retryMs: 10 });
    connection.start();
    await waitFor(() => socketCount > 1);
    assert.notEqual(connection.status().state, 'ready');
    wrong = false;
    await waitFor(() => connection.status().state === 'ready');
    await assert.rejects(connection.call('set_group_ban', {}), error => error.kind === 'offline');
    assert.equal(pending.action, 'set_group_ban');
    await waitFor(() => connection.status().state === 'ready');
    assert.equal(events.length, 0);
  }));

test('normalization preserves native segments, source identity, mention, private scope, poke and recall without executing text CQ commands', () => {
  const message = normalizeOneBotEvent(
    { ...raw, message: '[CQ:at,qq=900] hi &#91;CQ:poke&#93;[CQ:reply,id=-55][CQ:image,url=https://cdn.test/a.png]' },
    '900',
    owner
  );
  assert.equal(message.IsMaster, true);
  assert.equal(message.IsAdmin, false);
  assert.equal(message.IsAtMe, true);
  assert.match(message.MessageText, /\[CQ:poke\]/);
  assert.equal(message.ReplyId, '-55');
  assert.equal(message.MessageMedia[0].Type, 'image');
  assert.equal(message.Target.scope, 'group');
  assert.equal(normalizeOneBotEvent({ ...raw, self_id: 999 }, '900', owner), undefined);
  const privateEvent = normalizeOneBotEvent({ ...raw, group_id: undefined, message_type: 'private' }, '900', owner);
  assert.equal(privateEvent.name, 'private.message.create');
  const poke = normalizeOneBotEvent({ ...raw, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: 900 }, '900', owner);
  assert.equal(poke.name, 'notice.create');
  assert.equal(poke._Poke.actorId, '100');
  assert.equal(normalizeOneBotEvent({ ...raw, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: 300 }, '900', owner), undefined);
  const recall = normalizeOneBotEvent({ ...raw, post_type: 'notice', notice_type: 'group_recall' }, '900', owner);
  assert.equal(recall.name, 'message.delete');
  assert.equal(recall.MessageId, '10');
  assert.throws(() => parseSegments(Array.from({ length: 201 }, () => ({ type: 'text', data: {} }))));
  assert.deepEqual(formatSegments([{ type: 'Text', value: '[CQ:poke]' }]), [{ type: 'text', data: { text: '[CQ:poke]' } }]);
});

const actionFixture = () => {
  const calls = [];
  let role = 'admin',
    targetRole = 'member',
    disabled = [],
    groups = ['200'];
  const connection = {
    config: { selfId: '900' },
    status: () => ({ state: 'ready', bots: [] }),
    call: async (action, params) => {
      calls.push({ action, params });
      if (action === 'get_group_member_info') return { group_id: params.group_id, user_id: params.user_id, role: params.user_id === 900 ? role : targetRole };
      if (action === 'get_msg') return { group_id: 999, message: [{ type: 'text', data: { text: '别群秘密' } }] };
      if (action.startsWith('send_') && action !== 'send_poke') return { message_id: 66 };
      return null;
    }
  };
  const actions = new OneBotActions(connection, () => ({ owner, groups, disabled }));
  const api = (key, args = {}, changes = {}) =>
    actions.api({ action: 'client.api', payload: { event: { ...event, ...changes }, key: `agentLink.${key}`, params: [args] } });
  return {
    calls,
    actions,
    api,
    setRole: value => {
      role = value;
    },
    setTargetRole: value => {
      targetRole = value;
    },
    disable: () => {
      disabled = ['group-admin', 'platform'];
    },
    revoke: () => {
      groups = [];
    }
  };
};

test('group actions recheck owner, whitelist, current scope, bot and target roles before changing platform state', async () => {
  const f = actionFixture();
  const mute = { action: 'mute', groupId: '200', userId: '300', seconds: 10 };
  for (const [args, changes] of [
    [mute, { UserId: '300', IsMaster: true }],
    [{ ...mute, groupId: '999' }, {}],
    [{ ...mute, userId: '100' }, {}],
    [{ ...mute, userId: '900' }, {}]
  ]) {
    assert.notEqual((await f.api('manageGroup', args, changes))[0].code, ResultCode.Ok);
  }
  assert.equal(
    f.calls.some(call => call.action === 'set_group_ban'),
    false
  );
  f.setRole('member');
  assert.notEqual((await f.api('manageGroup', mute))[0].code, ResultCode.Ok);
  f.setRole('admin');
  f.setTargetRole('admin');
  assert.notEqual((await f.api('manageGroup', mute))[0].code, ResultCode.Ok);
  f.setTargetRole('member');
  assert.equal((await f.api('manageGroup', mute))[0].code, ResultCode.Ok);
  assert.deepEqual(f.calls.at(-1), { action: 'set_group_ban', params: { group_id: 200, user_id: 300, duration: 10 } });
  assert.notEqual((await f.api('manageGroup', { action: 'title', groupId: '200', userId: '300', text: '茶友' }))[0].code, ResultCode.Ok);
  f.setRole('owner');
  assert.equal((await f.api('manageGroup', { action: 'title', groupId: '200', userId: '300', text: '茶友' }))[0].code, ResultCode.Ok);
  assert.equal(f.calls.at(-1).action, 'set_group_special_title');
  f.revoke();
  assert.notEqual((await f.api('manageGroup', mute))[0].code, ResultCode.Ok);
});

test('text, media and poke use exact OneBot operations and reject invalid receipts, bot mismatches, unscoped reads and disabled calls', async () => {
  const f = actionFixture();
  const result = await f.actions.action({ action: 'message.send', payload: { event, params: { format: [{ type: 'Text', value: '你好' }], replyId: '10' } } });
  assert.equal(result[0].code, ResultCode.Ok);
  assert.deepEqual(f.calls.at(-1).params.message, [
    { type: 'reply', data: { id: '10' } },
    { type: 'text', data: { text: '你好' } }
  ]);
  assert.equal(
    (
      await f.actions.action({
        action: 'media.send',
        payload: { event, params: { type: 'audio', data: Buffer.from('ID3').toString('base64'), content: 'AI 合成语音' } }
      })
    )[0].code,
    ResultCode.Ok
  );
  assert.equal(f.calls.at(-1).params.message.at(-1).type, 'record');
  assert.equal((await f.api('poke'))[0].code, ResultCode.Ok);
  assert.deepEqual(f.calls.at(-1), { action: 'send_poke', params: { user_id: 100, group_id: 200 } });
  assert.notEqual((await f.api('readMessage', { messageId: '10' }))[0].code, ResultCode.Ok);
  assert.notEqual((await f.api('poke', {}, { BotId: '999' }))[0].code, ResultCode.Ok);
  f.disable();
  assert.notEqual((await f.api('poke'))[0].code, ResultCode.Ok);
});

test('durable action records suppress duplicates and preserve unknown outcomes across restart; poke is scoped and cooled down', () =>
  fixture(async root => {
    let ledger = new PlatformLedger(root),
      writes = 0;
    const operation = { action: 'mute', userId: '300' };
    try {
      const execute = async () => {
        writes++;
        throw new PlatformOperationError('timeout');
      };
      assert.equal((await ledger.run(context, operation, execute)).state, 'unknown');
      ledger.close();
      ledger = new PlatformLedger(root);
      assert.equal((await ledger.run(context, operation, execute)).state, 'unknown');
      assert.equal(writes, 1);
      assert.equal(
        (
          await ledger.run({ ...context, inputId: 'next' }, operation, async () => {
            writes++;
          })
        ).ok,
        true
      );
      assert.equal(
        (
          await ledger.run({ ...context, inputId: 'bad' }, operation, async () => {
            throw new PlatformOperationError('rejected');
          })
        ).state,
        'rejected'
      );
      assert.equal(ledger.claimCooldown('scope', 20), true);
      assert.equal(ledger.claimCooldown('scope', 20), false);
      assert.equal(ledger.claimCooldown('other', 20), true);
    } finally {
      ledger.close();
    }
    const config = getDSHConfig({ workspaceRoot: join(root, 'work') });
    const poke = normalizeOneBotEvent(
      { ...raw, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: 900, time: Date.now() / 1000 },
      '900',
      owner
    );
    assert.equal(claimPoke(config, poke), true);
    assert.equal(claimPoke(config, poke), false);
    assert.equal(claimPoke(config, { ...poke, UserId: '300' }), false);
    assert.equal(claimPoke(config, { ...poke, OccurredAt: Date.now() - 120000 }), false);
  }));

test('actual tool-model loop receives and executes only authorized group operations through the platform bridge', () =>
  fixture(async root => {
    const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
    const oldFetch = globalThis.fetch;
    const f = actionFixture();
    const configValue = {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'homes'),
        modules: { settings: { memory: { automatic: false }, 'group-admin': { groups: ['200'] } } }
      }
    };
    let modelCalls = 0,
      config;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      modelCalls++;
      assert.ok(body.tools.some(tool => tool.function.name === 'manage_group'));
      if (modelCalls === 1)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'manage', type: 'function', function: { name: 'manage_group', arguments: '{"action":"mute","userId":"300","seconds":10}' } }]
              }
            }
          ]
        });
      assert.equal(JSON.parse(body.messages.at(-1).content).state, 'confirmed');
      return Response.json({ choices: [{ message: { content: '平台已确认禁言十秒。' } }] });
    };
    try {
      const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => f.actions.api(frame) };
      await runtimeScope.run(runtime, async () => {
        getConfig().saveValue(configValue);
        config = getDSHConfig();
        const output = [];
        await runModuleTurn({
          config,
          sessionId: 'onebot-test',
          input: context.userText,
          context,
          onEvent: async event => {
            if (event.type === 'content') output.push(event.content);
          }
        });
        assert.equal(output.join(''), '平台已确认禁言十秒。');
        const lease = await (await getModuleRuntime(config)).acquire();
        assert.equal(
          lease.tools({ ...context, owner: false }).some(tool => tool.name === 'manage_group'),
          false
        );
        await lease.release();
      });
      assert.equal(f.calls.filter(call => call.action === 'set_group_ban').length, 1);
    } finally {
      if (config) await (await getModuleRuntime(config)).close();
      globalThis.fetch = oldFetch;
    }
  }));

test('standalone worker launches the real OneBot adapter and reaches readiness only after verified WebSocket login', () =>
  fixture(async root =>
    serverFixture(async ({ server, config }) => {
      let logins = 0;
      server.on('connection', socket =>
        socket.on('message', bytes => {
          const request = JSON.parse(bytes.toString());
          assert.equal(request.action, 'get_login_info');
          logins++;
          socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { user_id: 900 } }));
        })
      );
      const configPath = join(root, 'config.yaml');
      await writeFile(
        configPath,
        JSON.stringify({
          onebot: config,
          'alemonjs-agent-link': { transport: 'onebot', apiKey: 'local-test-no-network', runtimeMode: 'chat-only', stateBackend: 'local' }
        }),
        { mode: 0o600 }
      );
      let worker,
        released = false;
      const output = [];
      try {
        await launchRuntime({
          cwd: root,
          configPath,
          dataRoot: join(root, 'data'),
          runtimeRoot: join(root, 'data'),
          timeoutMs: 15000,
          write: text => output.push(text),
          ownership: {
            release: async () => {
              released = true;
            }
          },
          spawnWorker: (...args) => (worker = fork(...args))
        });
        assert.ok(logins >= 1);
        assert.match(output.join(''), /机器人已在线/u);
      } finally {
        if (worker && worker.exitCode === null) {
          const stopped = once(worker, 'close');
          worker.kill('SIGTERM');
          await stopped;
        }
      }
      assert.equal(released, true);
    })
  ));
