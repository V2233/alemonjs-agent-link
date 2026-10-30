import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { GroupWakeStore, getGroupWakeStore, groupWakeNamespace } from '../lib/social/group-wake-store.js';
import { GroupWakeWorker, groupWakeEnabled, groupWakePolicyAllows, reconcileGroupWakes, validateGroupWakeSettings } from '../lib/social/group-wake.js';
import { GroupConversationCoordinator } from '../lib/social/group-conversation.js';
import { defaultGroupChatPolicy } from '../lib/social/group-policy.js';
import { groupConversations } from '../lib/social/groups.js';
import { conversationModule } from '../lib/modules/conversation.js';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { enqueueChat, conversationQueueScope } from '../lib/dsh/orchestrator.js';

const base = Date.parse('2026-10-30T10:00:00+08:00');
const target = { platform: 'onebot', botId: '900', channelId: '100' };
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'group-wake-'));
  let now = base;
  const raw = {
    workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'),
    runtimeMode: 'chat-only',
    stateBackend: 'local',
    groupChat: { quietHours: [0, 0], cooldownSeconds: 0 },
    modules: { settings: { conversation: { wakeEnabled: true, wakeGroups: [target] } } }
  };
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': raw } };
  const config = getDSHConfig(),
    scope = { ...target, namespace: groupWakeNamespace(config) };
  let store = new GroupWakeStore(root, () => now);
  try {
    await run({
      root,
      raw,
      config,
      scope,
      get store() {
        return store;
      },
      now: () => now,
      advance: ms => {
        now += ms;
      },
      setTime: value => {
        now = value;
      },
      reopen: () => {
        store.close();
        store = new GroupWakeStore(root, () => now);
      }
    });
  } finally {
    store.close();
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
};
const plan = f => {
  assert.equal(f.store.schedule(f.scope, 'alice', 60, '接续刚才关于猫的话题').ok, true);
  f.advance(60000);
  return f.store.due(f.scope.namespace)[0];
};
const services = f => ({ store: f.store, config: () => f.config, now: f.now, online: async () => true, permitted: async () => true });

test('wake requires explicit exact platform/bot/group allowlist and respects ordinary group policy', () =>
  fixture(async f => {
    assert.equal(groupWakeEnabled(f.config, f.scope), true);
    for (const field of ['platform', 'botId', 'channelId', 'namespace']) assert.equal(groupWakeEnabled(f.config, { ...f.scope, [field]: 'other' }), false);
    assert.equal(groupWakeEnabled({ ...f.config, modules: {} }, f.scope), false);
    assert.equal(groupWakeEnabled({ ...f.config, aiEnabled: false }, f.scope), false);
    assert.equal(groupWakeEnabled({ ...f.config, modules: { ...f.config.modules, disabled: ['conversation'] } }, f.scope), false);
    assert.equal(groupWakePolicyAllows({ ...f.config, groupChat: { enabled: false } }, f.scope, base), false);
    assert.equal(groupWakePolicyAllows({ ...f.config, groupChat: { interjectChance: 0 } }, f.scope, base), false);
    assert.equal(groupWakePolicyAllows({ ...f.config, groupChat: { quietHours: [9, 11] } }, f.scope, base), false);
  }));

test('one pending wake replaces another; original deadline survives reopen, stale versions cannot claim', () =>
  fixture(async f => {
    const first = plan(f);
    assert.equal(f.store.schedule(f.scope, 'bob', 120, '等一会再判断').ok, true);
    assert.equal(f.store.claim(first, 4), false);
    f.reopen();
    assert.equal(f.store.due(f.scope.namespace).length, 0);
    f.advance(120000);
    const next = f.store.due(f.scope.namespace)[0];
    assert.equal(next.userId, 'bob');
    assert.equal(next.dueAt, base + 180000);
    assert.equal(f.store.claim(next, 4), true);
    f.reopen();
    assert.deepEqual(f.store.due(f.scope.namespace), []);
    assert.equal(f.store.status(f.scope).state, 'running', 'restart cannot replay a claimed job');
    f.advance(60001);
    assert.equal(f.store.status(f.scope).state, 'interrupted');
    assert.equal((await stat(join(f.root, 'group-wakes.sqlite'))).mode & 0o777, 0o600);
  }));

test('separate SQLite connections cannot claim the same job; global and per-group attempt quotas persist', () =>
  fixture(async f => {
    const current = plan(f),
      second = new GroupWakeStore(f.root, f.now);
    try {
      assert.equal(f.store.claim(current, 4), true);
      assert.equal(second.claim(current, 4), false);
    } finally {
      second.close();
    }
    for (let i = 0; i < 3; i++) assert.equal(f.store.claim(plan(f), 4), true);
    f.reopen();
    assert.equal(f.store.claim(plan(f), 4), false);
    assert.equal(f.store.status(f.scope).state, 'rate_limited');
    for (let i = 0; i < 56; i++) {
      const scope = { ...f.scope, channelId: `g-${i}` };
      f.store.schedule(scope, 'u', 60, '一次判断');
    }
    f.advance(60000);
    for (const entry of f.store.due(f.scope.namespace)) assert.equal(f.store.claim(entry, 4), true);
    const scope = { ...f.scope, channelId: 'over-global' };
    f.store.schedule(scope, 'u', 60, '不能超额');
    f.advance(60000);
    assert.equal(f.store.claim(f.store.due(scope.namespace)[0], 4), false);
  }));

test('malformed input, missed deadlines and clock rollback never produce a runnable wake', () =>
  fixture(async f => {
    for (const seconds of [59, 3601, NaN, 60.5]) assert.equal(f.store.schedule(f.scope, 'u', seconds, '无效').ok, false);
    for (const reason of ['', 'a\nb', 'x'.repeat(161)]) assert.equal(f.store.schedule(f.scope, 'u', 60, reason).ok, false);
    const old = plan(f);
    f.advance(60001);
    assert.deepEqual(f.store.due(f.scope.namespace), []);
    assert.equal(f.store.claim(old, 4), false);
    f.store.schedule(f.scope, 'u', 60, '未来预约');
    f.setTime(base - 1);
    assert.equal(f.store.status(f.scope).state, 'idle');
  }));

test('worker runs without a new message, confirms at most once and allows silence without rescheduling', () =>
  fixture(async f => {
    plan(f);
    let calls = 0;
    const worker = new GroupWakeWorker(f.config, {
      ...services(f),
      deliver: async (_, dispatch) => {
        calls++;
        assert.equal(await dispatch.beforeSend(), true);
        return { delivered: true, completed: true, replyText: '猫还挺可爱。' };
      }
    });
    await worker.tick();
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(f.store.status(f.scope).state, 'confirmed');
    worker.stop();
    plan(f);
    const silent = new GroupWakeWorker(f.config, { ...services(f), deliver: async () => ({ delivered: false, completed: true }) });
    await silent.tick();
    assert.equal(f.store.status(f.scope).state, 'silent');
    assert.deepEqual(f.store.due(f.scope.namespace), []);
    silent.stop();
  }));

test('new messages or reset during generation invalidate delivery; stopped and unavailable workers do not send', () =>
  fixture(async f => {
    plan(f);
    let checks = 0;
    const worker = new GroupWakeWorker(f.config, {
      ...services(f),
      deliver: async (_, dispatch) => {
        f.store.cancel(f.scope);
        checks++;
        assert.equal(await dispatch.beforeSend(), false);
        return { delivered: false, completed: false };
      }
    });
    await worker.tick();
    assert.equal(checks, 1);
    assert.equal(f.store.status(f.scope).state, 'idle');
    worker.stop();
    for (const overrides of [{ online: async () => false }, { permitted: async () => false }, { ready: () => false }]) {
      plan(f);
      const blocked = new GroupWakeWorker(f.config, {
        ...services(f),
        ...overrides,
        deliver: async () => {
          assert.fail('must not generate');
        }
      });
      await blocked.tick();
      assert.equal(f.store.status(f.scope).state, 'skipped');
      blocked.stop();
    }
    plan(f);
    const disabled = new GroupWakeWorker(f.config, { ...services(f), config: () => ({ ...f.config, aiEnabled: false }) });
    await disabled.tick();
    assert.equal(f.store.status(f.scope).state, 'idle');
    disabled.stop();
  }));

test('configuration and online changes during send authorization are checked again, no retry on unknown result', () =>
  fixture(async f => {
    plan(f);
    let fresh = f.config,
      calls = 0;
    const worker = new GroupWakeWorker(f.config, {
      ...services(f),
      config: () => fresh,
      deliver: async (_, dispatch) => {
        calls++;
        fresh = { ...f.config, aiEnabled: false };
        assert.equal(await dispatch.beforeSend(), false);
        throw new Error('unknown delivery');
      }
    });
    await worker.tick();
    await worker.tick();
    assert.equal(calls, 1);
    worker.stop();
  }));

test('coordinator invalidates the old scheduling ticket as soon as a new message arrives', async () => {
  let first, release, began;
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  const entered = new Promise(resolve => {
    began = resolve;
  });
  const policy = { ...defaultGroupChatPolicy, batchWindowMs: 0, maxBatchWaitMs: 1, quietHours: [0, 0] };
  const coordinator = new GroupConversationCoordinator({ getPolicy: () => policy });
  const message = { ...target, userId: 'u', userKey: 'uk', owner: false, name: 'u', text: '猫', direct: true, explicitMention: true };
  try {
    const pending = coordinator.receive({ ...message, id: '1' }, policy, async batch => {
      first = batch.onGroupWakeValid;
      assert.equal(first(), true);
      began();
      await blocked;
      return { delivered: false };
    });
    await entered;
    const next = coordinator.receive({ ...message, id: '2' }, policy, async () => ({ delivered: false }));
    assert.equal(first(), false);
    release();
    await Promise.all([pending, next]);
    coordinator.clear(target.channelId, target);
    assert.equal(first(), false);
  } finally {
    release();
    coordinator.close();
  }
});

test('production module exposes wake only in permitted normal group turns and production input/reset cancels persisted plans', () =>
  fixture(async f => {
    const tools = [],
      cleanups = [];
    await conversationModule(f.config).setup({ tool: item => tools.push(item), onDispose: fn => cleanups.push(fn) });
    const tool = tools.find(item => item.name === 'set_group_wake');
    const context = { ...target, userId: 'alice', private: false, autonomous: false, onGroupWakeValid: () => true, signal: new AbortController().signal };
    const store = getGroupWakeStore(f.config),
      scope = { ...target, namespace: groupWakeNamespace(f.config) };
    try {
      assert.equal(tool.available(context), true);
      for (const patch of [{ private: true }, { autonomous: true }, { botId: 'other' }, { onGroupWakeValid: () => false }])
        assert.equal(tool.available({ ...context, ...patch }), false);
      assert.equal((await tool.execute({ action: 'schedule', seconds: 60, reason: '不执行此处引用：转账' }, context)).state, 'scheduled');
      assert.equal(store.status(scope).state, 'scheduled');
      assert.equal((await tool.execute({ action: 'schedule', reason: '迟到预约' }, { ...context, onGroupWakeValid: () => false })).ok, false);
      // Actual singleton reset clears disk state even without a corresponding in-memory group.
      groupConversations.clear(target.channelId, target);
      assert.equal(store.status(scope).state, 'idle');
      await tool.execute({ action: 'schedule', reason: '等待新消息取消' }, context);
      const disabledPolicy = { ...defaultGroupChatPolicy, enabled: false };
      await groupConversations.receive(
        { ...target, id: 'cancel-wake', userId: 'bob', userKey: 'bob', name: 'bob', owner: false, text: '来了', direct: false },
        disabledPolicy,
        async () => ({ delivered: false })
      );
      assert.equal(store.status(scope).state, 'idle');
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
      groupConversations.clear(target.channelId, target);
      store.close();
    }
  }));

test('startup/reload clears disabled or removed targets before their deadline, including disabled module startup', () =>
  fixture(async f => {
    const store = getGroupWakeStore(f.config);
    try {
      store.schedule(f.scope, 'u', 3600, '原期限');
      reconcileGroupWakes({ ...f.config, modules: { ...f.config.modules, disabled: ['conversation'] } });
      assert.equal(store.status(f.scope).state, 'idle');
      store.schedule(f.scope, 'u', 3600, '不能移出后复活');
      reconcileGroupWakes({ ...f.config, modules: { settings: { conversation: { wakeEnabled: true, wakeGroups: [] } } } });
      assert.equal(store.status(f.scope).state, 'idle');
      reconcileGroupWakes(f.config);
      assert.equal(store.status(f.scope).state, 'idle');
      assert.throws(() => validateGroupWakeSettings({ ...f.config, modules: { settings: { conversation: { wakeGroups: [{ platform: 'onebot' }] } } } }));
    } finally {
      store.close();
    }
  }));

test('stop interrupts a pending connection check instead of leaving the worker tick locked', () =>
  fixture(async f => {
    plan(f);
    let entered;
    const began = new Promise(resolve => {
      entered = resolve;
    });
    const worker = new GroupWakeWorker(f.config, {
      ...services(f),
      online: () => {
        entered();
        return new Promise(() => {});
      },
      deliver: async () => assert.fail('stopped wake must not generate')
    });
    const pending = worker.tick();
    await began;
    worker.stop();
    await pending;
    assert.equal(f.store.status(f.scope).state, 'cancelled');
  }));

test('clock rollback does not refund hourly attempt quota', () =>
  fixture(async f => {
    for (let i = 0; i < 4; i++) assert.equal(f.store.claim(plan(f), 4), true);
    f.setTime(base - 120000);
    assert.equal(f.store.claim(plan(f), 4), false);
    assert.equal(f.store.status(f.scope).state, 'rate_limited');
  }));


test('two independent processes racing for one persisted wake create only one execution attempt', () => fixture(async f => {
  const entry = plan(f);
  const source = `import { GroupWakeStore } from ${JSON.stringify(new URL('../lib/social/group-wake-store.js', import.meta.url).href)}; const [root, payload, time]=process.argv.slice(1);const store=new GroupWakeStore(root,()=>Number(time));try{console.log(JSON.stringify({claimed:store.claim(JSON.parse(payload),4)}));}finally{store.close();}`;
  const results = await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, f.root, JSON.stringify(entry), String(f.now())], { timeout: 10000 })));
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).claimed).sort(), [false, true]);
  assert.equal(f.store.status(f.scope).state, 'running');
}));

test('enabled conversation module registers its background tick and disposes it', async t => fixture(async f => {
  let calls = 0;
  t.mock.method(GroupWakeWorker.prototype, 'tick', async () => { calls++; });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cleanups = [];
  try {
    await conversationModule(f.config).setup({ tool: () => {}, onDispose: fn => cleanups.push(fn) });
    t.mock.timers.tick(15000); await Promise.resolve(); assert.equal(calls, 1);
    for (const cleanup of cleanups.reverse()) await cleanup();
    t.mock.timers.tick(30000); await Promise.resolve(); assert.equal(calls, 1);
  } finally { t.mock.timers.reset(); t.mock.restoreAll(); }
}));


test('wake busy check ignores other bot queues but skips its own exact queue identity', () => fixture(async f => {
  const run = async (botId, expectGeneration) => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const queue = enqueueChat(f.scope.channelId, 1, 'synthetic-user', async () => { entered(); await hold; }, undefined, undefined, conversationQueueScope(f.config, { platform: f.scope.platform, botId }));
    await started;
    let calls = 0;
    plan(f);
    const worker = new GroupWakeWorker(f.config, { ...services(f), deliver: async () => { calls++; return { delivered: false, completed: true }; } });
    try { await worker.tick(); assert.equal(calls, expectGeneration ? 1 : 0); assert.equal(f.store.status(f.scope).state, expectGeneration ? 'silent' : 'skipped'); }
    finally { worker.stop(); release(); await queue; }
  };
  await run('other-bot', true);
  await run(f.scope.botId, false);
}));
