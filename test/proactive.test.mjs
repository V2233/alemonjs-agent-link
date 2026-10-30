import { conversationQueueScope } from '../lib/dsh/conversation-scope.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getConfig, ResultCode } from 'alemonjs';
import { proactiveOptions, isQuiet, localDay } from '../lib/proactive/options.js';
import { ProactiveStore, getProactiveStore } from '../lib/proactive/store.js';
import { ProactiveWorker, deliverProactive } from '../lib/proactive/worker.js';
import { deliverGroupWake } from '../lib/social/group-wake.js';
import { groupWakeNamespace } from '../lib/social/group-wake-store.js';
import { beginProactive, proactiveChannel, proactiveScopeId } from '../lib/proactive/control.js';
import { readingSettings } from '../lib/proactive/reading-settings.js';
import { observeProactiveInput, observeProactiveOutput } from '../lib/proactive/observe.js';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { ModuleRuntime, getModuleRuntime, executeTool } from '../lib/agent/modules.js';
import { getChatArchive } from '../lib/history/store.js';
import { OneBotActions } from '../lib/onebot/actions.js';
import { getPersonaStore } from '../lib/companion/personas.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { getMemoryStore } from '../lib/memory/store.js';

const scope = { platform: 'onebot', botId: '900', userId: '100' };
const base = Date.parse('2026-10-26T10:00:00+08:00');
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'proactive-'));
  let now = base;
  const config = getDSHConfig({
    workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'),
    runtimeMode: 'chat-only',
    stateBackend: 'local',
    modules: { settings: { memory: { automatic: false }, proactive: { activity: 'balanced' } } }
  });
  let store = new ProactiveStore(
    root,
    () => now,
    () => 0
  );
  try {
    await run({
      root,
      config,
      get store() {
        return store;
      },
      options: proactiveOptions(config),
      advance: minutes => {
        now += minutes * 60000;
      },
      setTime: value => {
        now = value;
      },
      now: () => now,
      reopen: () => {
        store.close();
        store = new ProactiveStore(
          root,
          () => now,
          () => 0
        );
      }
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
};

test('schedule requires subscription, waits for both idle and interval, persists daily budgets and stops unanswered sends', () =>
  fixture(async f => {
    assert.equal(f.store.claim(scope, f.options, 1000), undefined);
    f.store.subscribe(scope, true, f.options);
    assert.equal(f.store.get(scope).nextAt, base + f.options.minIntervalMinutes * 60000);
    f.advance(59);
    assert.equal(f.store.claim(scope, f.options, 1000), undefined);
    f.advance(1);
    const first = f.store.claim(scope, f.options, 1000);
    assert.equal(first.kind, 'initial');
    assert.equal(f.store.claim(scope, f.options, 1000), undefined);
    assert.equal(f.store.sending(first, f.options), true);
    assert.equal(f.store.sending(first, f.options), true, 'multiple chunks share one unanswered increment');
    assert.equal(f.store.finish(first, 'confirmed', '今天有空喝茶吗？'), 'confirmed');
    f.reopen();
    assert.equal(f.store.get(scope).count, 1);
    assert.equal(f.store.get(scope).unanswered, 1);
    f.advance(15);
    const follow = f.store.claim(scope, f.options, 1000);
    assert.equal(follow.kind, 'nudge');
    f.store.sending(follow, f.options);
    f.store.finish(follow, 'confirmed', '有空再聊呀？');
    f.advance(180);
    assert.equal(f.store.claim(scope, f.options, 1000), undefined);
    assert.equal(f.store.get(scope).count, 1, 'nudge has its own budget');
    assert.equal(f.store.input(scope, 'reply'), true);
    assert.equal(f.store.input(scope, 'reply'), false, 'a duplicate incoming frame does not reset the conversation twice');
    assert.equal(f.store.get(scope).unanswered, 0);
    assert.equal(f.store.claim(scope, f.options, 1000), undefined, 'fresh input must postpone a due task');
  }));

test('quiet hours, timezone calendar rollover, zero caps, pause and manual requests have explicit boundaries', () =>
  fixture(async f => {
    assert.equal(isQuiet(Date.parse('2026-10-26T23:00:00+08:00'), f.options), true);
    assert.equal(isQuiet(Date.parse('2026-10-27T07:59:00+08:00'), f.options), true);
    assert.equal(isQuiet(Date.parse('2026-10-27T08:00:00+08:00'), f.options), false);
    assert.notEqual(
      localDay(Date.parse('2026-10-26T23:59:00+08:00'), f.options.timezone),
      localDay(Date.parse('2026-10-27T00:00:00+08:00'), f.options.timezone)
    );
    const options = { ...f.options, maxPerDay: 1, maxUnanswered: 20, nudge: false };
    f.store.subscribe(scope, true, options);
    const first = f.store.claim(scope, options, 1000, true);
    f.store.finish(first, 'silent');
    assert.equal(f.store.claim(scope, options, 1000, true), undefined);
    f.setTime(Date.parse('2026-10-27T00:10:00+08:00'));
    assert.equal(f.store.claim(scope, options, 1000), undefined, 'new calendar day does not override quiet hours');
    assert.equal(f.store.due(scope, { ...options, maxPerDay: 0 }, true), false);
    assert.equal(f.store.claim(scope, { ...options, maxPerDay: 0 }, 1000, true), undefined);
    f.setTime(Date.parse('2026-10-27T10:00:00+08:00'));
    f.store.pause(scope, 60);
    assert.equal(f.store.claim(scope, options, 1000), undefined);
    const manual = f.store.claim(scope, options, 1000, true);
    assert.ok(manual, 'explicit manual request may bypass time scheduling while retaining daily cap');
    f.store.finish(manual, 'silent');
  }));

test('one question gets one nudge opportunity and probability is not retried every minute', () =>
  fixture(async f => {
    const options = { ...f.options, maxUnanswered: 20, nudgeChance: 0 };
    f.store.subscribe(scope, true, options);
    f.store.output(scope, 'ordinary-question', '饭吃了吗？');
    f.advance(15);
    assert.equal(f.store.claim(scope, options, 1000), undefined);
    assert.equal(f.store.get(scope).nudgedFor, f.store.get(scope).questionId);
    assert.equal(f.store.claim(scope, { ...options, nudgeChance: 1 }, 1000), undefined);
    f.store.input(scope, 'answer');
    f.store.output(scope, 'new-question', '要喝茶吗？');
    f.advance(15);
    const follow = f.store.claim(scope, { ...options, nudgeChance: 1 }, 1000);
    assert.equal(follow.kind, 'nudge');
    f.store.sending(follow, options);
    f.store.finish(follow, 'confirmed', '有空再回我就好');
    f.advance(1);
    assert.equal(f.store.claim(scope, { ...options, nudgeChance: 1 }, 1000), undefined);
  }));

test('restart distinguishes unstarted work from uncertain delivery and never automatically retries a possible send', () =>
  fixture(async f => {
    f.store.subscribe(scope, true, f.options);
    const generating = f.store.claim(scope, f.options, 1000, true);
    f.reopen();
    f.advance(1);
    f.store.recover();
    assert.equal(f.store.attempts(scope)[0].status, 'failed');
    assert.equal(f.store.sending(generating, f.options), false);
    const sending = f.store.claim(scope, f.options, 1000, true);
    f.store.sending(sending, f.options);
    f.reopen();
    f.advance(1);
    f.store.recover();
    assert.equal(f.store.attempts(scope)[0].status, 'unknown');
    assert.equal(f.store.get(scope).pausedUntil, Number.MAX_SAFE_INTEGER);
    f.advance(24 * 60);
    assert.equal(f.store.claim(scope, f.options, 1000), undefined);
    f.store.pause(scope, 0);
    f.store.input(scope, 'checked-platform');
    const next = f.store.claim(scope, f.options, 1000, true);
    assert.notEqual(next.id, sending.id);
    assert.equal(f.store.sending(sending, f.options), false);
  }));

test('new input aborts active generation; opting out, scope isolation and purge reject stale dispatch', () =>
  fixture(async f => {
    f.store.subscribe(scope, true, f.options);
    const job = beginProactive(f.root, scope);
    const pending = f.store.claim(scope, f.options, 1000, true);
    assert.ok(job);
    f.store.input(scope, 'new');
    assert.equal(job.signal.aborted, true);
    assert.equal(f.store.sending(pending, f.options, true), false);
    assert.equal(f.store.finish(pending, 'cancelled'), 'cancelled');
    job.release();
    f.store.subscribe(scope, false, f.options);
    assert.equal(f.store.claim(scope, f.options, 1000, true), undefined);
    assert.equal(f.store.get({ ...scope, botId: '901' }), undefined);
    f.store.subscribe(scope, true, f.options);
    const next = f.store.claim(scope, f.options, 1000, true);
    f.store.purgeHash(createHash('sha256').update(proactiveChannel(scope)).digest('hex'));
    assert.equal(f.store.get(scope), undefined);
    assert.equal(f.store.sending(next, f.options, true), false);
    assert.deepEqual(f.store.attempts(scope), []);
  }));

test('automatic activity does not extend user inactivity retention and options reject invalid clocks and budgets', () =>
  fixture(async f => {
    f.store.subscribe(scope, true, f.options);
    f.advance(29 * 24 * 60);
    const attempt = f.store.claim(scope, f.options, 1000, true);
    f.store.sending(attempt, f.options, true);
    f.store.finish(attempt, 'confirmed', '你好呀');
    f.advance(2 * 24 * 60);
    f.store.cleanup(30);
    assert.equal(f.store.get(scope), undefined);
    for (const settings of [
      { timezone: 'Invalid/Zone' },
      { minIntervalMinutes: 100, maxIntervalMinutes: 50 },
      { nudgeMinMinutes: 15, nudgeMaxMinutes: 10 },
      { quietHours: [24, 8] },
      { maxPerDay: -1 }
    ]) {
      assert.throws(() => proactiveOptions({ modules: { settings: { proactive: settings } } }));
    }
  }));

test('worker revalidates authorization and configuration before sending and persists unknown rather than claiming failure', () =>
  fixture(async f => {
    f.store.subscribe(scope, true, f.options);
    let allowed = true,
      enabled = true,
      online = true,
      mode = 'success',
      deliveries = 0;
    const worker = new ProactiveWorker(f.config, {
      store: f.store,
      owner: () => allowed,
      online: async () => online,
      config: () => ({ ...f.config, modules: { settings: { proactive: { enabled } } } }),
      deliver: async (_scope, prompt, dispatch) => {
        deliveries++;
        assert.match(prompt, /系统主动搭话提醒，不是主人发言/u);
        if (mode === 'revoke') allowed = false;
        if (!(await dispatch.beforeSend())) return { completed: false, delivered: false };
        if (mode === 'timeout') throw new Error('lost receipt');
        return { completed: true, delivered: true, replyText: '你好呀' };
      }
    });
    try {
      online = false;
      assert.equal(await worker.run(scope, true), 'offline');
      assert.equal(deliveries, 0);
      online = true;
      mode = 'revoke';
      assert.equal(await worker.run(scope, true), 'failed');
      assert.equal(f.store.get(scope).unanswered, 0);
      allowed = true;
      mode = 'timeout';
      assert.equal(await worker.run(scope, true), 'unknown');
      assert.equal(f.store.get(scope).pausedUntil, Number.MAX_SAFE_INTEGER);
      enabled = false;
      assert.equal(await worker.run(scope, true), 'disabled');
    } finally {
      worker.stop();
    }
  }));

test('proactive prompt offers optional read-only browsing only when Bilibili browsing is enabled', () =>
  fixture(async f => {
    f.store.subscribe(scope, true, f.options);
    let observed = '';
    const config = { ...f.config, modules: { settings: { bili: { enabled: true, allowProactiveBrowse: true } } } };
    const worker = new ProactiveWorker(config, {
      store: f.store,
      config: () => config,
      owner: () => true,
      online: async () => true,
      deliver: async (_scope, prompt) => {
        observed = prompt;
        return { delivered: false, completed: true };
      }
    });
    try {
      assert.equal(await worker.run(scope, true), 'silent');
      assert.match(observed, /只读的 B 站搜索/);
      assert.match(observed, /不要评论、点赞或联系他人/);
    } finally {
      worker.stop();
    }
  }));

test('autonomous tool leases and executor reject writes even when a recipient is the owner', () =>
  fixture(async f => {
    const runtime = new ModuleRuntime(f.config, [
      {
        id: 'sample',
        name: 'sample',
        version: '1',
        apiVersion: 1,
        setup(api) {
          for (const readOnly of [true, false])
            api.tool({
              name: readOnly ? 'read' : 'write',
              readOnly,
              description: 'sample',
              parameters: { type: 'object', properties: {} },
              execute: async () => ({ ok: true })
            });
        }
      }
    ]);
    const lease = await runtime.acquire();
    const context = {
      platform: 'onebot',
      channelId: proactiveChannel(scope),
      userId: scope.userId,
      private: true,
      owner: true,
      autonomous: true,
      userText: '',
      capabilities: { chat: true, web: false, files: false, terminal: false },
      signal: new AbortController().signal
    };
    try {
      assert.deepEqual(
        lease.tools(context).map(tool => tool.name),
        ['read']
      );
      const write = lease.tools({ ...context, autonomous: false }).find(tool => tool.name === 'write');
      await assert.rejects(executeTool(write, {}, context), /主动消息/u);
    } finally {
      await lease.release();
      await runtime.close();
    }
  }));

const pipeline = async run =>
  fixture(async f => {
    const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
    const oldFetch = globalThis.fetch;
    const nativeCalls = [];
    const connection = {
      config: { selfId: scope.botId },
      status: () => ({ state: 'ready', bots: [{ BotId: scope.botId, state: 'ready' }] }),
      call: async (action, params) => {
        nativeCalls.push({ action, params });
        return { message_id: nativeCalls.length };
      }
    };
    const actions = new OneBotActions(connection, () => ({ owner: id => id === scope.userId, groups: ['200'], disabled: [] }));
    const runtime = {
      resources: new Map(),
      cleanups: new Set(),
      disposed: false,
      now: Date.now,
      action: frame => actions.action(frame),
      api: frame => actions.api(frame)
    };
    let config;
    try {
      await runtimeScope.run(runtime, async () => {
        getConfig().saveValue({
          onebot: { master_id: [scope.userId] },
          'alemonjs-agent-link': {
            apiKey: 'test',
            model: 'test',
            runtimeMode: 'chat-only',
            stateBackend: 'local',
            workspaceRoot: f.config.workspaceRoot,
            dshHomeRoot: f.config.dshHomeRoot,
            modules: {
              settings: {
                memory: { automatic: false },
                mood: { modelJudge: false },
                expression: { automatic: false },
                'group-admin': { groups: ['200'] }
              }
            }
          }
        });
        config = getDSHConfig();
        const store = getProactiveStore(config);
        store.subscribe(scope, true, proactiveOptions(config));
        const worker = new ProactiveWorker(config);
        try {
          await run({ ...f, config, store, worker, nativeCalls });
        } finally {
          worker.stop();
        }
      });
    } finally {
      if (config) await (await getModuleRuntime(config)).close();
      globalThis.fetch = oldFetch;
    }
  });

test('proactive delivery can browse a real tool result and remember the actual reading', () =>
  pipeline(async f => {
    f.worker.stop();
    const current = getConfig().value;
    const app = current['alemonjs-agent-link'];
    getConfig().saveValue({
      ...current,
      'alemonjs-agent-link': {
        ...app,
        modules: { ...app.modules, settings: { ...app.modules.settings, memory: { automatic: true }, bili: { enabled: true, allowProactiveBrowse: true } } }
      }
    });
    const config = getDSHConfig();
    const worker = new ProactiveWorker(config);
    const bvid = 'BV1234567890';
    const nav = { data: { wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } } };
    let modelCalls = 0,
      searchCalls = 0,
      watchCalls = 0;
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address.endsWith('/nav')) return Response.json(nav);
      if (address.includes('/search/type')) {
        searchCalls++;
        return Response.json({ code: 0, data: { result: [{ bvid, title: '鲸鱼的海', author: '作者' }] } });
      }
      if (address.includes('/wbi/view')) {
        watchCalls++;
        return Response.json({ code: 0, data: { bvid, aid: 123, cid: 456, title: '鲸鱼的海', desc: '研究鲸鱼的歌声' } });
      }
      if (address.includes('/player/')) return Response.json({ code: 0, data: { subtitle: { subtitles: [] } } });
      if (address.includes('/reply/')) return Response.json({ code: 0, data: { replies: [] } });
      const body = JSON.parse(init.body);
      modelCalls++;
      assert.ok(body.tools.some(tool => tool.function.name === 'bili_search'));
      assert.equal(
        body.tools.some(tool => tool.function.name === 'bili_comment'),
        false
      );
      if (modelCalls === 1)
        return Response.json({
          choices: [
            { message: { content: null, tool_calls: [{ id: 'search', type: 'function', function: { name: 'bili_search', arguments: '{"keyword":"鲸鱼"}' } }] } }
          ]
        });
      if (modelCalls === 2)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'watch', type: 'function', function: { name: 'bili_watch', arguments: JSON.stringify({ link: bvid }) } }]
              }
            }
          ]
        });
      assert.match(JSON.stringify(body.messages), /研究鲸鱼的歌声/);
      return Response.json({ choices: [{ message: { content: '刚发现一条讲鲸鱼歌声的视频，标题有点意思。' } }] });
    };
    try {
      assert.equal(await worker.run(scope, true), 'confirmed');
      assert.equal(modelCalls, 3);
      assert.equal(searchCalls, 1);
      assert.equal(watchCalls, 1);
      assert.equal(f.nativeCalls.filter(item => item.action === 'send_private_msg').length, 1);
      const events = getMemoryStore(config).list({ platform: scope.platform, channelId: proactiveChannel(scope) }, { subjectId: scope.botId });
      assert.equal(events.length, 2);
      assert.match(events.find(item => item.tags.includes('资料')).text, /研究鲸鱼的歌声/);
      assert.match(events.find(item => item.tags.includes('阅读感想')).text, /标题有点意思/);
      assert.notEqual(await worker.run(scope, true), 'confirmed');
      assert.equal(f.nativeCalls.filter(item => item.action === 'send_private_msg').length, 1);
    } finally {
      worker.stop();
    }
  }));

test('incoming owner message cancels in-flight proactive browsing without a message or false experience', () =>
  pipeline(async f => {
    f.worker.stop();
    const current = getConfig().value;
    const app = current['alemonjs-agent-link'];
    getConfig().saveValue({
      ...current,
      'alemonjs-agent-link': {
        ...app,
        modules: { ...app.modules, settings: { ...app.modules.settings, memory: { automatic: true }, bili: { enabled: true, allowProactiveBrowse: true } } }
      }
    });
    const config = getDSHConfig();
    const worker = new ProactiveWorker(config);
    let started;
    const ready = new Promise(resolve => {
      started = resolve;
    });
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/nav')) {
        started();
        await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }));
        init.signal.throwIfAborted();
      }
      return Response.json({
        choices: [
          {
            message: { content: null, tool_calls: [{ id: 'watch', type: 'function', function: { name: 'bili_watch', arguments: '{"link":"BV1234567890"}' } }] }
          }
        ]
      });
    };
    try {
      const pending = worker.run(scope, true);
      await ready;
      observeProactiveInput(config, {
        Platform: scope.platform,
        BotId: scope.botId,
        UserId: scope.userId,
        IsPrivate: true,
        IsMaster: true,
        MessageId: 'cancel-browse',
        MessageText: '我来了'
      });
      assert.equal(await pending, 'cancelled');
      assert.equal(f.nativeCalls.filter(item => item.action === 'send_private_msg').length, 0);
      assert.deepEqual(getMemoryStore(config).list({ platform: scope.platform, channelId: proactiveChannel(scope) }, { subjectId: scope.botId }), []);
    } finally {
      worker.stop();
    }
  }));

test('real delivery pipeline uses owner persona and history readers without write tools, sends a scoped platform message, and does not archive a fake user message', () =>
  pipeline(async f => {
    const personas = getPersonaStore(f.config);
    await personas.save({ id: 'companion', name: '茶友', prompt: '用自然简短的中文回应。', privateRules: '保持主人的私聊称呼。', socialRules: '公共称呼。' });
    await personas.select({ platform: scope.platform, channelId: proactiveChannel(scope) }, 'companion');
    let response = '今天有空喝茶吗？';
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests++;
      assert.match(body.messages[0].content, /系统调度的主动搭话，不是用户新发来的请求/u);
      assert.match(body.messages[0].content, /保持主人的私聊称呼/u);
      assert.doesNotMatch(body.messages[0].content, /公共称呼/u);
      const tools = body.tools.map(tool => tool.function.name);
      assert.ok(tools.includes('recall_memories'));
      assert.ok(tools.includes('search_chat_history'));
      for (const denied of ['remember_private_fact', 'manage_group', 'poke_speaker', 'agent_workspace']) assert.equal(tools.includes(denied), false);
      assert.match(JSON.stringify(body.messages.at(-1).content), /系统主动搭话提醒，不是主人发言/u);
      if (requests > 1) {
        assert.ok(body.messages.some(message => message.role === 'assistant' && message.content === '今天有空喝茶吗？'));
        assert.equal(
          body.messages.slice(0, -1).some(message => message.role === 'user' && String(message.content).includes('【系统主动搭话提醒，不是主人发言】')),
          false
        );
      }
      return Response.json({ choices: [{ message: { content: response } }] });
    };
    assert.equal(await f.worker.run(scope, true), 'confirmed');
    assert.equal(f.nativeCalls.length, 1);
    assert.equal(f.nativeCalls[0].action, 'send_private_msg');
    assert.equal(f.nativeCalls[0].params.user_id, 100);
    assert.deepEqual(f.nativeCalls[0].params.message, [{ type: 'text', data: { text: '今天有空喝茶吗？' } }]);
    const archive = getChatArchive(f.config);
    const rows = archive.search({ platform: scope.platform, channelId: proactiveChannel(scope) }).items;
    assert.equal(rows.filter(row => row.role === 'user').length, 0);
    assert.equal(rows.filter(row => row.role === 'assistant').length, 1);
    const registry = new SessionRegistry(f.config);
    const channelId = proactiveChannel(scope);
    const meta = await registry.meta(channelId);
    assert.deepEqual(await registry.privateHistory({ channelId, generation: meta.generation, scope: conversationQueueScope(f.config, scope) }), [{ role: 'assistant', content: '今天有空喝茶吗？' }]);
    assert.equal(f.store.get(scope).unanswered, 1);
    response = '[沉默]';
    observeProactiveInput(f.config, {
      Platform: scope.platform,
      BotId: scope.botId,
      UserId: scope.userId,
      IsPrivate: true,
      IsMaster: true,
      MessageId: 'new-one',
      MessageText: '你好'
    });
    assert.equal(await f.worker.run(scope, true), 'silent');
    assert.equal(f.nativeCalls.length, 1);
    response = '长'.repeat(301);
    assert.equal(await f.worker.run(scope, true), 'silent');
    assert.equal(f.nativeCalls.length, 1);
  }));

test('incoming owner message cancels actual model generation and direct opt-out survives a new worker', () =>
  pipeline(async f => {
    let started;
    const ready = new Promise(resolve => {
      started = resolve;
    });
    globalThis.fetch = async (_url, init) => {
      started();
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    };
    const task = f.worker.run(scope, true);
    await ready;
    const event = {
      Platform: scope.platform,
      BotId: scope.botId,
      UserId: scope.userId,
      IsPrivate: true,
      IsMaster: true,
      MessageId: 'stop',
      MessageText: '请不要再主动找我了'
    };
    observeProactiveInput(f.config, event);
    assert.equal(await task, 'cancelled');
    assert.equal(f.nativeCalls.length, 0);
    assert.equal(f.store.get(scope).enabled, false);
    const worker = new ProactiveWorker(f.config);
    try {
      assert.equal(await worker.run(scope, true), 'not-due');
    } finally {
      worker.stop();
    }
  }));

test('ordinary proactive messages stay text and use the explicit recipient instead of a fabricated reply id', () =>
  pipeline(async f => {
    const settings = getConfig().value;
    settings['alemonjs-agent-link'].modules.settings.expression = { automatic: true, voiceChance: 1, stickerChance: 0 };
    settings['alemonjs-agent-link'].media = { tts: { baseUrl: 'https://speech.test', apiKey: 'test', model: 'tts', voice: 'voice' } };
    getConfig().saveValue(settings);
    globalThis.fetch = async url =>
      String(url).endsWith('/audio/speech') ? new Response('ID3test') : Response.json({ choices: [{ message: { content: '要喝茶吗？' } }] });
    assert.equal(await f.worker.run(scope, true), 'confirmed');
    assert.equal(f.nativeCalls.length, 1);
    assert.equal(f.nativeCalls[0].action, 'send_private_msg');
    assert.equal(f.nativeCalls[0].params.message.at(-1).type, 'text');
    assert.equal(
      f.nativeCalls[0].params.message.some(segment => segment.type === 'reply'),
      false
    );
  }));

test('daily reading survives restart and respects quiet hours and subscriptions', () =>
  fixture(f => {
    f.store.subscribe(scope, true, f.options);
    assert.equal(f.store.claimDailyBrowse(scope, f.options), true);
    f.reopen();
    assert.equal(f.store.claimDailyBrowse(scope, f.options), false);
    f.setTime(Date.parse('2026-10-27T02:00:00+08:00'));
    assert.equal(f.store.claimDailyBrowse(scope, f.options), false);
    f.setTime(Date.parse('2026-10-27T10:00:00+08:00'));
    assert.equal(f.store.claimDailyBrowse(scope, f.options), true);
    f.store.subscribe(scope, false, f.options);
    f.advance(1440);
    assert.equal(f.store.claimDailyBrowse(scope, f.options), false);
  }));

test('daily browsing runs without a due outgoing message and does not send or consume message quota', () =>
  fixture(async f => {
    const config = { ...f.config, modules: { settings: { bili: { dailyBrowse: true }, proactive: { activity: 'balanced', ownKeyMax: false } } } };
    f.store.subscribe(scope, true, f.options);
    let readings = 0;
    const worker = new ProactiveWorker(config, {
      store: f.store,
      config: () => config,
      owner: () => true,
      browse: async (_config, target, signal) => {
        assert.equal(signal.aborted, false);
        assert.deepEqual(target.userId, scope.userId);
        readings++;
      },
      deliver: () => assert.fail('reading must not dispatch an outgoing message')
    });
    try {
      await worker.tick();
      await worker.tick();
      assert.equal(readings, 1);
      assert.equal(f.store.dailyBrowseStatus(scope).status, 'completed');
      assert.equal(f.store.get(scope).count, 0);
      assert.equal(f.store.get(scope).unanswered, 0);
    } finally {
      worker.stop();
    }
  }));

test('background tool restriction cannot be bypassed through execution', async () => {
  let called = false;
  const tool = {
    name: 'unrelated_read',
    readOnly: true,
    parameters: { type: 'object' },
    execute: async () => {
      called = true;
    }
  };
  await assert.rejects(() => executeTool(tool, {}, { autonomous: true, allowedTools: ['bili_watch'], signal: new AbortController().signal }), /未开放/);
  assert.equal(called, false);
});

test('stopping the worker aborts independent reading and does not retry it after restart that day', () =>
  fixture(async f => {
    const config = { ...f.config, modules: { settings: { bili: { dailyBrowse: true }, proactive: { activity: 'balanced', ownKeyMax: false } } } };
    f.store.subscribe(scope, true, f.options);
    let begin;
    const started = new Promise(resolve => {
      begin = resolve;
    });
    const worker = new ProactiveWorker(config, {
      store: f.store,
      config: () => config,
      owner: () => true,
      browse: (_config, _scope, signal) =>
        new Promise((resolve, reject) => {
          begin();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    });
    const pending = worker.tick();
    await started;
    worker.stop();
    await assert.rejects(() => pending);
    assert.equal(f.store.dailyBrowseStatus(scope).status, 'cancelled');
    const restarted = new ProactiveWorker(config, {
      store: f.store,
      config: () => config,
      owner: () => true,
      browse: () => assert.fail('same-day interrupted reading must not be retried')
    });
    try {
      await restarted.tick();
    } finally {
      restarted.stop();
    }
  }));

test('daily browse outcomes persist and late results cannot replace a newer attempt', () =>
  fixture(f => {
    f.store.subscribe(scope, true, f.options);
    assert.equal(f.store.claimDailyBrowse(scope, f.options), true);
    const first = f.store.dailyBrowseStatus(scope);
    assert.equal(first.status, 'running');
    f.store.finishDailyBrowse(scope, first.at, 'recorded');
    f.reopen();
    assert.equal(f.store.dailyBrowseStatus(scope).status, 'recorded');
    f.advance(1440);
    assert.equal(f.store.claimDailyBrowse(scope, f.options), true);
    const next = f.store.dailyBrowseStatus(scope);
    f.store.finishDailyBrowse(scope, first.at, 'failed');
    assert.equal(f.store.dailyBrowseStatus(scope).status, 'running');
    f.store.finishDailyBrowse(scope, next.at, 'failed');
    assert.equal(f.store.dailyBrowseStatus(scope).status, 'failed');
  }));

test('only confirmed initial shares enter the scoped seven-day duplicate index', () =>
  fixture(f => {
    const options = { ...f.options, maxPerDay: 20, maxUnanswered: 20 };
    f.store.subscribe(scope, true, options);
    const text = '这条鲸鱼视频很有意思 https://www.bilibili.com/video/BV1234567890';
    const first = f.store.claim(scope, options, 1000, true);
    assert.ok(first);
    f.store.finish(first, 'failed', text);
    assert.equal(f.store.duplicateShare(scope, text), false);
    const confirmed = f.store.claim(scope, options, 1000, true);
    assert.ok(confirmed);
    f.store.finish(confirmed, 'confirmed', text);
    assert.equal(f.store.duplicateShare(scope, text), true);
    assert.equal(f.store.duplicateShare(scope, '换一种说法 BV1234567890'), true);
    assert.deepEqual(f.store.recentSharedVideos(scope), ['BV1234567890']);
    assert.deepEqual(f.store.recentSharedVideos({ ...scope, userId: 'other' }), []);
    assert.equal(f.store.duplicateShare({ ...scope, userId: 'other' }, text), false);
    assert.equal(f.store.duplicateShare(scope, '全新的消息'), false);
    const split = f.store.claim(scope, options, 1000, true);
    f.store.finish(split, 'confirmed', '今天看到一条视频\n内容很有趣');
    assert.equal(f.store.duplicateShare(scope, '今天看到一条视频|||内容很有趣'), true);
    f.reopen();
    assert.equal(f.store.duplicateShare(scope, text), true);
    f.advance(7 * 1440);
    assert.equal(f.store.duplicateShare(scope, text), false);
  }));

test('duplicate share is rejected before entering the sending state', () =>
  fixture(async f => {
    const options = { ...f.options, maxPerDay: 20, maxUnanswered: 20 };
    f.store.subscribe(scope, true, options);
    const text = '值得看看 BV1234567890';
    const old = f.store.claim(scope, options, 1000, true);
    f.store.finish(old, 'confirmed', text);
    let allowed;
    const worker = new ProactiveWorker(f.config, {
      store: f.store,
      config: () => f.config,
      owner: () => true,
      online: async () => true,
      deliver: async (_scope, _prompt, dispatch) => {
        allowed = await dispatch.beforeSend('又发现这条 BV1234567890');
        return { completed: false, delivered: false };
      }
    });
    try {
      assert.equal(await worker.run(scope, true), 'failed');
      assert.equal(allowed, false);
      assert.notEqual(f.store.get(scope).pausedUntil, Number.MAX_SAFE_INTEGER);
    } finally {
      worker.stop();
    }
  }));

test('explicit reading feedback is scoped, replaceable, persistent and reversible', () =>
  fixture(f => {
    f.store.setBrowseFeedback(scope, 'ＡＰＥＸ', 'like');
    assert.deepEqual(f.store.browseFeedback(scope), [{ topic: 'apex', preference: 'like' }]);
    f.store.setBrowseFeedback(scope, 'apex', 'avoid');
    f.reopen();
    assert.deepEqual(f.store.browseFeedback(scope), [{ topic: 'apex', preference: 'avoid' }]);
    assert.deepEqual(f.store.browseFeedback({ ...scope, userId: 'other' }), []);
    f.store.setBrowseFeedback(scope, 'apex', 'clear');
    assert.deepEqual(f.store.browseFeedback(scope), []);
    for (let i = 0; i < 25; i++) f.store.setBrowseFeedback(scope, `topic-${i}`, 'like');
    assert.equal(f.store.browseFeedback(scope).length, 20);
  }));

test('verified owner feedback is captured once while group and non-owner text cannot alter it', () =>
  fixture(f => {
    const store = getProactiveStore(f.config);
    const event = {
      Platform: scope.platform,
      BotId: scope.botId,
      UserId: scope.userId,
      IsPrivate: true,
      IsMaster: true,
      MessageId: 'feedback-1',
      MessageText: '以后别看恐怖'
    };
    observeProactiveInput(f.config, event);
    assert.deepEqual(store.browseFeedback(scope), [{ topic: '恐怖', preference: 'avoid' }]);
    observeProactiveInput(f.config, { ...event, MessageText: '恢复推荐恐怖' });
    assert.equal(store.browseFeedback(scope).length, 1);
    observeProactiveInput(f.config, { ...event, MessageId: 'group', IsPrivate: false, MessageText: '恢复推荐恐怖' });
    observeProactiveInput(f.config, { ...event, MessageId: 'non-owner', IsMaster: false, MessageText: '恢复推荐恐怖' });
    assert.equal(store.browseFeedback(scope).length, 1);
    observeProactiveInput(f.config, { ...event, MessageId: 'feedback-2', MessageText: '恢复推荐恐怖' });
    assert.deepEqual(store.browseFeedback(scope), []);
  }));

test('private reading settings persist, isolate scope, retain the other field and reset to global defaults', () =>
  fixture(f => {
    assert.deepEqual(f.store.dailyBrowseSettings(scope, false, [9, 22]), { enabled: false, window: [9, 22] });
    f.store.setDailyBrowse(scope, { enabled: true });
    f.store.setDailyBrowse(scope, { window: [22, 2] });
    f.reopen();
    assert.deepEqual(f.store.dailyBrowseSettings(scope, false), { enabled: true, window: [22, 2] });
    assert.deepEqual(f.store.dailyBrowseSettings({ ...scope, userId: 'other' }, false), { enabled: false, window: undefined });
    assert.throws(() => f.store.setDailyBrowse(scope, { window: [24, 2] }));
    const job = beginProactive(f.root, scope);
    assert.ok(job);
    f.store.setDailyBrowse(scope, { enabled: false });
    assert.equal(job.signal.aborted, true);
    job.release();
    assert.deepEqual(f.store.dailyBrowseSettings(scope, true), { enabled: false, window: [22, 2] });
    f.store.resetDailyBrowse(scope);
    assert.deepEqual(f.store.dailyBrowseSettings(scope, true, [18, 22]), { enabled: true, window: [18, 22] });
  }));

test('private opt-in drives independent reading without enabling it globally', () =>
  fixture(async f => {
    const config = { ...f.config, modules: { settings: { proactive: { ownKeyMax: false } } } };
    f.store.subscribe(scope, true, f.options);
    f.store.setDailyBrowse(scope, { enabled: true });
    let readings = 0;
    const worker = new ProactiveWorker(config, {
      store: f.store,
      config: () => config,
      owner: () => true,
      browse: async () => {
        readings++;
      }
    });
    try {
      await worker.tick();
      assert.equal(readings, 1);
      f.advance(1440);
      f.store.setDailyBrowse(scope, { enabled: false });
      // Keep the outgoing-message branch inactive to isolate the independent reading check.
      f.store.input(scope, 'new-day');
      await worker.tick();
      assert.equal(readings, 1);
    } finally {
      worker.stop();
    }
  }));

test('offline due messages cannot starve another subscribed conversations daily reading', () =>
  fixture(async f => {
    const config = { ...f.config, modules: { settings: { bili: { dailyBrowse: true }, proactive: { activity: 'balanced', ownKeyMax: false } } } };
    const other = { ...scope, userId: '101' };
    const reader = { ...scope, userId: '102' };
    f.store.subscribe(scope, true, f.options);
    f.store.subscribe(other, true, f.options);
    f.advance(60);
    f.store.subscribe(reader, true, f.options);
    const read = [];
    let onlineChecks = 0;
    const worker = new ProactiveWorker(config, {
      store: f.store,
      config: () => config,
      owner: () => true,
      online: async () => {
        onlineChecks++;
        return false;
      },
      browse: async (_config, target) => {
        read.push(target.userId);
      }
    });
    try {
      await worker.tick();
      await worker.tick();
      assert.deepEqual(read, ['102']);
      assert.equal(onlineChecks, 4);
      assert.equal(f.store.get(reader).count, 0);
    } finally {
      worker.stop();
    }
  }));

test('turning off proactive work during message handling blocks the subsequent reading phase', () =>
  fixture(async f => {
    let config = { ...f.config, modules: { settings: { bili: { dailyBrowse: true }, proactive: { activity: 'balanced', ownKeyMax: false } } } };
    f.store.subscribe(scope, true, f.options);
    f.advance(60);
    f.store.subscribe({ ...scope, userId: 'reader' }, true, f.options);
    const worker = new ProactiveWorker(config, {
      store: f.store,
      config: () => config,
      owner: () => true,
      online: async () => {
        config = { ...config, modules: { disabled: ['proactive'] } };
        return false;
      },
      browse: () => assert.fail('changed configuration must be checked before reading')
    });
    try {
      await worker.tick();
    } finally {
      worker.stop();
    }
  }));

test('AI master switch prevents independent reading without consuming the daily attempt', () =>
  fixture(async f => {
    const config = { ...f.config, aiEnabled: false, modules: { settings: { bili: { dailyBrowse: true }, proactive: { ownKeyMax: false } } } };
    f.store.subscribe(scope, true, f.options);
    const worker = new ProactiveWorker(config, {
      store: f.store,
      config: () => config,
      owner: () => true,
      browse: () => assert.fail('AI disabled must not start a reading'),
      online: () => assert.fail('AI disabled must not start message handling')
    });
    try {
      await worker.tick();
      assert.equal(f.store.dailyBrowseStatus(scope), undefined);
      assert.equal(await worker.run(scope, true), 'disabled');
    } finally {
      worker.stop();
    }
  }));

test('hobby activity interval and daily cap survive restart; disabled subscriptions do not run', async () => {
  await fixture(async f => {
    f.store.subscribe(scope, true, f.options);
    assert.equal(f.store.claimHobbyActivity(scope, f.options, 15, 2), true);
    f.store.finishHobbyActivity(scope, f.store.hobbyActivity(scope).runId, 'recorded');
    assert.equal(f.store.claimHobbyActivity(scope, f.options, 15, 2), false);
    f.reopen();
    assert.equal(f.store.hobbyActivityStatus()[0].status, 'recorded');
    f.advance(15);
    assert.equal(f.store.claimHobbyActivity(scope, f.options, 15, 2), true);
    f.advance(15);
    assert.equal(f.store.claimHobbyActivity(scope, f.options, 15, 2), false);
    f.setTime(Date.parse('2026-10-27T10:00:00+08:00'));
    assert.equal(f.store.claimHobbyActivity(scope, f.options, 15, 2), true);
    f.store.subscribe(scope, false, f.options);
    f.advance(15);
    assert.equal(f.store.claimHobbyActivity(scope, f.options, 15, 2), false);
  });
});

test('managed hobby reading honors private opt-out and persisted reading windows', async () =>
  fixture(async f => {
    const config = {
      ...f.config,
      modules: {
        settings: {
          proactive: { ownKeyMax: false, idleMinutes: 1440, minIntervalMinutes: 1440, maxIntervalMinutes: 1440 },
          hobbies: { enabled: true, bilibili: true, autonomous: true, intervalMinutes: 15, maxPerDay: 2 },
          bili: { dailyBrowse: false, dailyBrowseWindow: [11, 12] }
        }
      }
    };
    f.store.subscribe(scope, true, proactiveOptions(config));
    assert.equal(readingSettings(config, f.store, scope).enabled, true, 'managed default must match worker behavior');
    f.store.setDailyBrowse(scope, { enabled: false, window: [11, 12] });
    let reads = 0;
    const createWorker = () =>
      new ProactiveWorker(config, {
        store: f.store,
        config: () => config,
        owner: () => true,
        browse: async () => {
          reads++;
          return 'recorded';
        }
      });
    let worker = createWorker();
    try {
      await worker.tick();
      assert.equal(reads, 0);
      assert.equal(f.store.hobbyActivity(scope), undefined);
      worker.stop();
      f.reopen();
      worker = createWorker();
      assert.equal(readingSettings(config, f.store, scope).enabled, false);
      f.store.setDailyBrowse(scope, { enabled: true });
      await worker.tick();
      assert.equal(reads, 0, 'enabled reading must still wait for its window');
      f.setTime(Date.parse('2026-10-26T11:59:00+08:00'));
      await worker.tick();
      assert.equal(reads, 1);
      assert.equal(f.store.hobbyActivity(scope).status, 'recorded');
    } finally {
      worker.stop();
    }
  }));

test('managed reading opt-out cancels the running activity and prevents the next tick', async () =>
  fixture(async f => {
    const config = {
      ...f.config,
      modules: {
        settings: {
          proactive: { ownKeyMax: false, idleMinutes: 1440, minIntervalMinutes: 1440, maxIntervalMinutes: 1440 },
          hobbies: { enabled: true, bilibili: true, autonomous: true, intervalMinutes: 15, maxPerDay: 3 }
        }
      }
    };
    f.store.subscribe(scope, true, proactiveOptions(config));
    let ready,
      release,
      reads = 0;
    const started = new Promise(resolve => {
      ready = resolve;
    });
    const gate = new Promise(resolve => {
      release = resolve;
    });
    const worker = new ProactiveWorker(config, {
      store: f.store,
      config: () => config,
      owner: () => true,
      browse: async (_config, _scope, signal) => {
        reads++;
        ready();
        await gate;
        assert.equal(signal.aborted, true);
        return 'recorded';
      }
    });
    try {
      const pending = worker.tick();
      await started;
      f.store.setDailyBrowse(scope, { enabled: false });
      release();
      await pending;
      assert.equal(f.store.hobbyActivity(scope).status, 'cancelled');
      f.advance(15);
      await worker.tick();
      assert.equal(reads, 1);
    } finally {
      release();
      worker.stop();
    }
  }));

test('hobby runs share a cross-midnight activity day and keep the cap after restart', async () =>
  fixture(async f => {
    const options = { ...f.options, quietHours: [0, 0] };
    f.store.subscribe(scope, true, options);
    f.setTime(Date.parse('2026-10-26T23:59:00+08:00'));
    assert.equal(f.store.claimHobbyActivity(scope, options, 15, 1, [22, 1]), true);
    assert.equal(f.store.hobbyActivity(scope).day, '2026-10-26');
    f.reopen();
    f.setTime(Date.parse('2026-10-27T00:59:00+08:00'));
    assert.equal(f.store.claimHobbyActivity(scope, options, 15, 1, [22, 1]), false);
    f.setTime(Date.parse('2026-10-27T01:01:00+08:00'));
    assert.equal(f.store.claimHobbyActivity(scope, options, 15, 1, [22, 1]), false);
    f.setTime(Date.parse('2026-10-28T00:59:00+08:00'));
    assert.equal(f.store.claimHobbyActivity(scope, options, 15, 1, [22, 1]), true);
    assert.equal(f.store.hobbyActivity(scope).day, '2026-10-27');
  }));

test('purging activity removes its status and stale same-time completion cannot alter a new run', async () =>
  fixture(async f => {
    f.store.subscribe(scope, true, f.options);
    assert.equal(f.store.claimHobbyActivity(scope, f.options, 15, 2), true);
    const old = f.store.hobbyActivity(scope);
    f.store.purgeHash(createHash('sha256').update(proactiveChannel(scope)).digest('hex'));
    assert.equal(f.store.hobbyActivity(scope), undefined);
    assert.deepEqual(f.store.hobbyActivityStatus(), []);
    f.store.subscribe(scope, true, f.options);
    assert.equal(f.store.claimHobbyActivity(scope, f.options, 15, 2), true);
    const current = f.store.hobbyActivity(scope);
    assert.equal(current.at, old.at);
    assert.notEqual(current.runId, old.runId);
    assert.equal(f.store.finishHobbyActivity(scope, old.runId, 'recorded'), false);
    assert.equal(f.store.hobbyActivity(scope).status, 'running');
    assert.equal(f.store.finishHobbyActivity(scope, current.runId, 'completed'), true);
    assert.equal(f.store.finishHobbyActivity(scope, current.runId, 'failed'), false);
  }));

test('global managed switches cannot be overridden by enabling a private reading setting', async () =>
  fixture(async f => {
    const config = { ...f.config, modules: { settings: { hobbies: { enabled: true, bilibili: true, autonomous: false } } } };
    f.store.setDailyBrowse(scope, { enabled: true });
    assert.equal(readingSettings(config, f.store, scope).enabled, false);
  }));

test('old hobby activity tables migrate without resetting day or attempt counts', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'hobby-migrate-'));
  let store;
  try {
    const db = new DatabaseSync(join(root, 'proactive.sqlite'));
    db.exec('CREATE TABLE hobby_activity(scope TEXT PRIMARY KEY,day TEXT NOT NULL,count INTEGER NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL)');
    db.prepare('INSERT INTO hobby_activity VALUES(?,?,?,?,?)').run(proactiveScopeId(scope), '2026-10-26', 2, base, 'recorded');
    db.close();
    store = new ProactiveStore(root, () => base);
    assert.deepEqual({ ...store.hobbyActivity(scope) }, { day: '2026-10-26', count: 2, at: base, status: 'recorded', runId: '' });
    store.close();
    store = new ProactiveStore(root, () => base);
    assert.equal(store.hobbyActivity(scope).count, 2);
    store.cleanup(30);
    assert.equal(store.hobbyActivity(scope), undefined, 'old orphan activity rows must not survive cleanup');
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});


test('group wake uses actual chat/delivery pipeline with group-scoped readonly tools, no automatic mention and no fake user history', () => pipeline(async f => {
  const plan = { namespace: groupWakeNamespace(f.config), platform: scope.platform, botId: scope.botId, channelId: '200', userId: scope.userId, id: 'test-group-wake', reason: '刚才谈到的猫', createdAt: Date.now() - 60000, dueAt: Date.now() };
  let requests = 0, checks = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests++;
    assert.match(body.messages[0].content, /只可读取当前会话范围内的资料/u);
    assert.doesNotMatch(body.messages[0].content, /只可读取当前私聊资料/u);
    const tools = body.tools.map(tool => tool.function.name);
    assert.ok(tools.includes('search_chat_history'));
    for (const denied of ['set_group_wake', 'set_group_wait', 'remember_private_fact', 'manage_group', 'poke_speaker', 'agent_workspace']) assert.equal(tools.includes(denied), false);
    assert.match(JSON.stringify(body.messages.at(-1).content), /系统群聊唤醒，不是群友的新消息/u);
    return Response.json({ choices: [{ message: { content: '猫这种生物，光看着就挺解压的。' } }] });
  };
  const result = await deliverGroupWake(plan, { signal: new AbortController().signal, beforeSend: async () => { checks++; return true; } });
  assert.equal(result.delivered, true); assert.equal(requests, 1); assert.ok(checks >= 1);
  const sends = f.nativeCalls.filter(item => item.action === 'send_group_msg');
  assert.equal(sends.length, 1); assert.equal(sends[0].params.group_id, 200);
  assert.ok(f.nativeCalls.every(item => item.action === 'send_group_msg' || item.action.startsWith('get_')));
  assert.deepEqual(sends[0].params.message, [{ type: 'text', data: { text: '猫这种生物，光看着就挺解压的。' } }]);
  const rows = getChatArchive(f.config).search({ platform: scope.platform, channelId: '200' }).items;
  assert.equal(rows.filter(row => row.role === 'user').length, 0); assert.equal(rows.filter(row => row.role === 'assistant').length, 1);
}));
