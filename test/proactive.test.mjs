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
import { beginProactive, proactiveChannel } from '../lib/proactive/control.js';
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
    modules: { settings: { memory: { automatic: false } } }
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
    assert.equal(f.store.get(scope).nextAt, base + 60 * 60000);
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
      assert.equal(events.length, 1);
      assert.match(events[0].text, /研究鲸鱼的歌声/);
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
      assert.match(body.messages[0].content, /系统调度的主动搭话，不是主人发来的请求/u);
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
    assert.deepEqual(await registry.privateHistory({ channelId, generation: meta.generation }), [{ role: 'assistant', content: '今天有空喝茶吗？' }]);
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

test('automatic voice remains available for proactive messages and uses the explicit recipient instead of a fabricated reply id', () =>
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
    assert.equal(f.nativeCalls[0].params.message.at(-1).type, 'record');
    assert.equal(
      f.nativeCalls[0].params.message.some(segment => segment.type === 'reply'),
      false
    );
  }));
