import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bridgeConversationIdentity, bridgeSessionHash, sessionBaseId, conversationQueueScope } from '../lib/dsh/conversation-scope.js';
import { DSHSupervisor, setDSHBridgeForTesting } from '../lib/dsh/supervisor.js';
import { streamChat, clearSession, purgeSessionData } from '../lib/dsh/client.js';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { runModuleTurn } from '../lib/agent/turn.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-scope-')),
    old = { config: globalThis.__config, fetch: globalThis.fetch };
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'sk-synthetic-credential',
        model: 'synthetic',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        budget: { enabled: false },
        modules: { disabled: ['opinions'], settings: { memory: { automatic: false }, mood: { modelJudge: false }, expression: { automatic: false } } }
      }
    }
  };
  const config = getDSHConfig(),
    identity = botId => bridgeConversationIdentity('g', conversationQueueScope(config, { platform: 'onebot', botId }));
  try {
    await run({ root, config, identity });
  } finally {
    setDSHBridgeForTesting(undefined);
    globalThis.fetch = old.fetch;
    globalThis.__config = old.config;
    await rm(root, { recursive: true, force: true });
  }
};
const done = () =>
  new Response('data: {"type":"content","content":"fixture"}\n\ndata: {"type":"done"}\n\n', { headers: { 'content-type': 'text/event-stream' } });

test('Bridge identity keeps a stable cleanup parent and separates bot/platform/installation scopes', () =>
  fixture(async f => {
    const a = f.identity('a'),
      b = f.identity('b');
    assert.equal(a.groupKey, bridgeSessionHash(sessionBaseId('g')));
    assert.equal(a.groupKey, b.groupKey);
    assert.notEqual(a.scopeKey, b.scopeKey);
    const scopes = [
      a,
      b,
      bridgeConversationIdentity('g', conversationQueueScope(f.config, { platform: 'other', botId: 'a' })),
      bridgeConversationIdentity('g', conversationQueueScope({ ...f.config, workspaceRoot: f.root + '/other' }, { platform: 'onebot', botId: 'a' }))
    ];
    assert.equal(new Set(scopes.map(row => row.scopeKey)).size, 4);
    assert.notEqual(bridgeSessionHash(sessionBaseId('g:v12')), bridgeSessionHash(sessionBaseId('g')));
    assert.ok(scopes.every(row => /^[0-9a-f]{64}$/.test(row.groupKey) && /^[0-9a-f]{64}$/.test(row.scopeKey)));
  }));

test('backend fallback pinning and deferred reset retain exact conversation parent ownership', () =>
  fixture(async f => {
    const supervisor = new DSHSupervisor({ ...f.config, runtimeMode: 'auto' }, null);
    try {
      assert.equal(supervisor.useSandbox(sessionBaseId('g') + ':v1', f.identity('a')), false);
      supervisor.statusValue = { phase: 'ready' };
      assert.equal(supervisor.useSandbox(sessionBaseId('g') + ':v1', f.identity('a')), false);
      assert.equal(supervisor.useSandbox(sessionBaseId('g') + ':v1', f.identity('b')), true);
      supervisor.statusValue = { phase: 'idle' };
      const sibling = bridgeConversationIdentity('g:v12', conversationQueueScope(f.config, { platform: 'onebot', botId: 'a' }));
      assert.equal(supervisor.useSandbox(sessionBaseId('g:v12') + ':v1', sibling), false);
      supervisor.queueSessionReset(sessionBaseId('g'));
      const urls = [];
      globalThis.fetch = async url => {
        urls.push(String(url));
        return new Response(null, { status: 204 });
      };
      await supervisor.flushSessionResets(new AbortController().signal);
      assert.ok(urls[0].endsWith('/v1/session-hash/' + f.identity('a').groupKey));
      supervisor.resetTransport(sessionBaseId('g'));
      supervisor.statusValue = { phase: 'ready' };
      assert.equal(supervisor.useSandbox(sessionBaseId('g') + ':v1', f.identity('a')), true);
      assert.equal(supervisor.useSandbox(sessionBaseId('g:v12') + ':v1', sibling), false);
    } finally {
      supervisor.stop();
    }
  }));

test('actual Bridge client sends explicit or history-derived identity and hashes destructive targets exactly', () =>
  fixture(async f => {
    setDSHBridgeForTesting({ url: 'http://synthetic-bridge.test', token: 'fixture' });
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      return options.method === 'DELETE' ? new Response(null, { status: 204 }) : done();
    };
    const base = sessionBaseId('g'),
      args = [f.config, base + ':v1', 'fixture', async () => {}, 'u', undefined, { chat: true, web: false, files: false, terminal: false }];
    await streamChat(...args, undefined, undefined, undefined, undefined, f.identity('a'));
    await streamChat(...args, { channelId: 'g', generation: 1, scope: conversationQueueScope(f.config, { platform: 'onebot', botId: 'b' }) });
    assert.deepEqual(JSON.parse(requests[0].options.body).conversation, f.identity('a'));
    assert.deepEqual(JSON.parse(requests[1].options.body).conversation, f.identity('b'));
    await clearSession(f.config, sessionBaseId('g:v12'));
    await purgeSessionData(f.config, base);
    assert.ok(requests[2].url.endsWith('/v1/session-hash/' + bridgeSessionHash(sessionBaseId('g:v12'))));
    assert.ok(requests[3].url.endsWith('/v1/group-hash/' + f.identity('a').groupKey));
  }));

test('actual workspace tool forwards the owning bot identity even without a PrivateHistoryContext', { timeout: 10000 }, () =>
  fixture(async f => {
    setDSHBridgeForTesting({ url: 'http://synthetic-bridge.test', token: 'fixture' });
    const captured = [];
    let step = 0;
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (String(url).startsWith('http://synthetic-bridge.test/')) {
        captured.push(body);
        return done();
      }
      assert.ok(String(url).endsWith('/chat/completions'));
      step++;
      return Response.json({
        choices: [
          {
            message:
              step % 2 === 1
                ? {
                    content: null,
                    tool_calls: [{ id: 'workspace', type: 'function', function: { name: 'agent_workspace', arguments: '{"task":"检查工作区"}' } }]
                  }
                : { content: '完成。' }
          }
        ]
      });
    };
    try {
      for (const botId of ['a', 'b'])
        await runModuleTurn({
          config: f.config,
          sessionId: sessionBaseId('g') + ':v1',
          input: '检查工作区',
          context: {
            platform: 'onebot',
            botId,
            channelId: 'g',
            userId: 'u',
            private: false,
            owner: false,
            userText: '检查工作区',
            allowedTools: ['agent_workspace'],
            capabilities: { chat: true, web: false, files: true, terminal: false },
            signal: AbortSignal.timeout(5000)
          },
          onEvent: async () => {}
        });
      assert.equal(captured.length, 2);
      assert.deepEqual(captured[0].conversation, f.identity('a'));
      assert.deepEqual(captured[1].conversation, f.identity('b'));
      assert.equal(captured[0].sessionId, captured[1].sessionId);
    } finally {
      await (await getModuleRuntime(f.config)).close();
    }
  })
);

test('Node identity is consumed by the actual Python parser without generation or special-channel ambiguity', { timeout: 10000 }, () =>
  fixture(async f => {
    const channelId = '群:v12/a',
      identity = bridgeConversationIdentity(channelId, conversationQueueScope(f.config, { platform: 'onebot', botId: 'a' }));
    const code = `import sys,json;sys.path.insert(0,sys.argv[1]);import dsh_bridge;print(json.dumps(dsh_bridge.conversation_keys(sys.argv[2],json.loads(sys.argv[3]))))`;
    const result = await promisify(execFile)(
      'python3',
      ['-c', code, join(process.cwd(), 'python'), sessionBaseId(channelId) + ':v2', JSON.stringify(identity)],
      {
        timeout: 5000,
        env: { PATH: process.env.PATH, DSH_WORKSPACE_ROOT: f.config.workspaceRoot, DSH_HOME_ROOT: f.config.dshHomeRoot, DSH_BRIDGE_TOKEN: 'fixture' }
      }
    );
    const [parent, key] = JSON.parse(result.stdout);
    assert.equal(parent, identity.groupKey);
    assert.equal(
      key,
      createHash('sha256')
        .update(parent + ':scope:' + identity.scopeKey)
        .digest('hex')
    );
  })
);

test('Bridge health rejects old or malformed protocol metadata before using a reused process', () =>
  fixture(async f => {
    const supervisor = new DSHSupervisor(f.config, null);
    try {
      for (const payload of [
        { status: 'ready', sandbox: true },
        { status: 'ready', sandbox: true, conversationScopes: 0 },
        { status: 'ready', sandbox: true, conversationScopes: true }
      ]) {
        globalThis.fetch = async () => Response.json(payload);
        await assert.rejects(supervisor.waitForHealth(1000), /conversation scope protocol/);
      }
      globalThis.fetch = async () => new Response('x'.repeat(8193));
      await assert.rejects(supervisor.waitForHealth(1000), /conversation scope protocol/);
      for (const nativePermissions of [undefined, 0, 1, true, '2', 3]) {
        globalThis.fetch = async () => Response.json({ status: 'ready', sandbox: true, conversationScopes: 1, nativePermissions });
        await assert.rejects(supervisor.waitForHealth(1000), /native permission protocol/);
      }
      globalThis.fetch = async () => Response.json({ status: 'ready', sandbox: true, conversationScopes: 1, nativePermissions: 2 });
      await supervisor.waitForHealth(1000);
    } finally {
      supervisor.stop();
    }
  }));

test('ordinary image and sampled-video input honors explicit vision before private memory reaches chat', () =>
  fixture(async f => {
    globalThis.__config.value['alemonjs-agent-link'].media = {
      vision: { baseUrl: 'https://explicit-vision.example/v1', apiKey: 'vision-fixture-key', model: 'explicit-vision' }
    };
    const calls = [];
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      if (String(url).startsWith('https://explicit-vision.example/')) {
        assert.equal(options.headers.Authorization, 'Bearer vision-fixture-key');
        assert.equal(body.model, 'explicit-vision');
        assert.ok(body.messages.at(-1).content.some(part => part.type === 'image_url'));
        assert.match(JSON.stringify(body), /1.50 秒/);
        assert.doesNotMatch(JSON.stringify(body), /private-memory-fixture/);
        return Response.json({ choices: [{ message: { content: '1.50秒可见红色方块。' }, finish_reason: 'stop' }] });
      }
      assert.ok(String(url).endsWith('/chat/completions'));
      assert.match(JSON.stringify(body.messages), /红色方块/);
      assert.match(JSON.stringify(body.messages), /private-memory-fixture/);
      assert.doesNotMatch(JSON.stringify(body.messages), /data:image/);
      return Response.json({ choices: [{ message: { content: '采样画面里是红色方块，未听音轨。' } }] });
    };
    try {
      await runModuleTurn({
        config: f.config, sessionId: 'vision-fixture',
        input: [{ type: 'text', text: '视频采样位置 1.50 秒，未听音轨。' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
        history: { channelId: 'g', generation: 1, memoryContext: 'private-memory-fixture' },
        context: { platform: 'onebot', botId: 'a', channelId: 'g', userId: 'u', private: false, owner: false,
          userText: '描述采样画面', allowedTools: ['media_capabilities'], capabilities: { chat: true, web: false, files: false, terminal: false }, signal: AbortSignal.timeout(5000) },
        onEvent: async () => {}
      });
      assert.equal(calls.length, 2);
      assert.ok(calls[0].url.startsWith('https://explicit-vision.example/'));
      let failedCalls = 0;
      globalThis.fetch = async url => {
        failedCalls++;
        assert.ok(String(url).startsWith('https://explicit-vision.example/'), 'must not silently send images to chat');
        return new Response('unavailable', { status: 503 });
      };
      await assert.rejects(runModuleTurn({
        config: f.config, sessionId: 'vision-failure-fixture',
        input: [{ type: 'text', text: '看图' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }],
        context: { platform: 'onebot', botId: 'a', channelId: 'g', userId: 'u', private: false, owner: false,
          userText: '看图', allowedTools: ['media_capabilities'], capabilities: { chat: true, web: false, files: false, terminal: false }, signal: AbortSignal.timeout(5000) },
        onEvent: async () => {}
      }), /HTTP 503/);
      assert.equal(failedCalls, 1);

    } finally { await (await getModuleRuntime(f.config)).close(); }
  }));
