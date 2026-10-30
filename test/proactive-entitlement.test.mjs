import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { entitledProactiveOptions, proactiveOptions } from '../lib/proactive/options.js';
import { ProactiveStore } from '../lib/proactive/store.js';
import { ProactiveWorker } from '../lib/proactive/worker.js';

const scope = { platform: 'onebot', botId: '900', userId: '100' };
const base = Date.parse('2026-10-26T10:00:00+08:00');

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'proactive-entitlement-'));
  const config = getDSHConfig({
    workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'),
    runtimeMode: 'chat-only',
    stateBackend: 'local',
    modules: { settings: { proactive: { quietHours: [0, 0], ownKeyMax: true } } }
  });
  let now = base;
  const store = new ProactiveStore(
    root,
    () => now,
    () => 0
  );

  return {
    root,
    config,
    store,
    advance: minutes => {
      now += minutes * 60000;
    }
  };
};

test('显式开启 ownKeyMax 后绑定 Key 的私聊提频，默认不提频且可关闭', () => {
  const config = getDSHConfig({ workspaceRoot: '/tmp/work', dshHomeRoot: '/tmp/home', stateBackend: 'local' });
  const defaults = proactiveOptions(config);
  assert.equal(defaults.ownKeyMax,false);
  assert.deepEqual(entitledProactiveOptions(defaults),defaults);
  const base = proactiveOptions({...config,modules:{settings:{proactive:{ownKeyMax:true}}}});
  const entitled = entitledProactiveOptions(base);

  assert.equal(base.ownKeyMax, true);
  assert.equal(entitled.idleMinutes, 20);
  assert.equal(entitled.minIntervalMinutes, 20);
  assert.equal(entitled.maxIntervalMinutes, 45);
  assert.equal(entitled.maxPerDay, 10);
  assert.equal(entitled.maxNudgesPerDay, 6);
  assert.equal(entitled.maxUnanswered, 3);
  assert.equal(entitled.flexible, true);

  const off = getDSHConfig({
    workspaceRoot: '/tmp/work',
    dshHomeRoot: '/tmp/home',
    stateBackend: 'local',
    modules: { settings: { proactive: { ownKeyMax: false } } }
  });

  assert.deepEqual(entitledProactiveOptions(proactiveOptions(off)), proactiveOptions(off));
});

test('拉满后不受下一次随机间隔限制，但仍受空闲与免打扰约束', async () => {
  const f = await setup();
  const options = proactiveOptions(f.config);
  const entitled = entitledProactiveOptions(options);

  f.store.subscribe(scope, true, options);
  f.advance(21);

  assert.equal(f.store.due(scope, options), false, '普通参数仍等待随机间隔');
  assert.equal(f.store.due(scope, entitled), true, '拉满后空闲达标即可');
});

test('自带 Key 的私聊由 worker 直接调度，未绑定时维持普通节奏', async () => {
  const f = await setup();
  const options = proactiveOptions(f.config);
  const deliveries = [];
  const deliver = async (_scope, _prompt, dispatch) => {
    if (!(await dispatch.beforeSend())) return { completed: false, delivered: false };
    deliveries.push(1);

    return { completed: true, delivered: true, replyText: '在的' };
  };

  f.store.subscribe(scope, true, options);
  f.advance(21);

  const plain = new ProactiveWorker(f.config, {
    store: f.store,
    config: () => f.config,
    owner: () => true,
    online: async () => true,
    entitled: async () => false,
    deliver
  });

  try {
    await plain.tick();
    assert.equal(deliveries.length, 0, '未绑定 Key 时不会提前搭话');
  } finally {
    plain.stop();
  }

  const entitled = new ProactiveWorker(f.config, {
    store: f.store,
    config: () => f.config,
    owner: () => true,
    online: async () => true,
    entitled: async () => true,
    deliver
  });

  try {
    await entitled.tick();
    assert.equal(deliveries.length, 1, '绑定 Key 后按拉满参数调度');
  } finally {
    entitled.stop();
  }
});
