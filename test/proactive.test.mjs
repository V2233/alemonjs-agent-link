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
