import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { GroupWaitStore } from '../lib/social/group-wait-store.js';
import { GroupWaitController } from '../lib/social/group-wait.js';
import { GroupConversationCoordinator } from '../lib/social/group-conversation.js';
import { getGroupChatPolicy } from '../lib/social/group-policy.js';
const scope = { namespace: 'workspace-a', platform: 'onebot', botId: 'fish-a', channelId: 'group-a' };
const saved = (createdAt = 1000) => ({ platform: 'onebot', userKey: 'owner-user-key', createdAt, plan: { speakerIds: ['alice', 'bob'], keyword: 'ＡＢＣ', expiresAt: createdAt + 60000 } });
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'group-wait-store-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
};
const message = (id, extra = {}) => ({ channelId: scope.channelId, platform: scope.platform, botId: scope.botId, id, userId: 'alice', userKey: 'owner-user-key', name: 'Alice', owner: false, text: '普通内容', direct: false, addressed: false, ...extra });
const policy = getGroupChatPolicy({ activity: 'active', quietHours: [0, 0], interjectChance: 1, cooldownSeconds: 0, interests: [] });
const services = (store, clock, extra = {}) => ({
  now: () => clock.now, waitNamespace: () => clock.namespace || scope.namespace,
  waitPersistence: current => store.persistence(current),
  clearPersistedWait: (channelId, current, userKey) => store.remove({ namespace: clock.namespace || scope.namespace, channelId, ...current }, userKey),
  schedule: () => 1, unschedule() {}, random: () => 0,
  classify: async () => ({ reply: true, addressed: 'none', related: 'my_thread', reason: 'context', source: 'human', loopRisk: false }), ...extra
});

test('short waits survive a real process exit and are consumed once without extending the original deadline', () => fixture(async root => {
  const code = `import {GroupWaitStore} from ${JSON.stringify(new URL('../lib/social/group-wait-store.js', import.meta.url).href)};
    import {GroupWaitController} from ${JSON.stringify(new URL('../lib/social/group-wait.js', import.meta.url).href)};
    const store=new GroupWaitStore(${JSON.stringify(root)});const c=new GroupWaitController(store.persistence(${JSON.stringify(scope)}),1000);
    const t=c.begin('onebot','owner-user-key');const result=c.apply(t,{action:'wait',speakerIds:['alice','bob'],keyword:'ＡＢＣ',seconds:60},['alice','bob'],'alice',1000);
    console.log(JSON.stringify(result));`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]);
  assert.equal(JSON.parse(child.stdout).expiresAt, 61000);
  const store = new GroupWaitStore(root);
  try {
    const c = new GroupWaitController(store.persistence(scope), 30000);
    assert.deepEqual(c.snapshot('onebot', 30000), { speakerIds: ['alice', 'bob'], keyword: 'ＡＢＣ', expiresAt: 61000 });
    assert.equal(c.observe({ platform: 'onebot', userId: 'stranger', text: 'abc', direct: false }, 30001), 'waiting');
    assert.equal(c.observe({ platform: 'onebot', userId: 'bob', text: '找到了abc', direct: false }, 30002), 'matched');
    assert.equal(new GroupWaitController(store.persistence(scope), 30003).snapshot('onebot', 30003), undefined);
    assert.equal((await stat(join(root, 'group-waits.sqlite'))).mode & 0o777, 0o600);
  } finally { store.close(); }
}));

test('workspace, group, platform, bot and cancellation owner remain isolated', () => fixture(async root => {
  const store = new GroupWaitStore(root);
  try {
    for (const variant of [{}, { namespace: 'workspace-b' }, { channelId: 'group-b' }, { botId: 'fish-b' }, { platform: 'other' }]) {
      const target = { ...scope, ...variant };
      store.save(target, { ...saved(), platform: target.platform });
    }
    assert.equal(store.remove(scope, 'wrong-owner'), false);
    assert.ok(store.load(scope, 1001));
    assert.equal(store.remove(scope, 'owner-user-key'), true);
    assert.ok(store.load({ ...scope, botId: 'fish-b' }, 1001));
    store.remove({ namespace: scope.namespace, channelId: scope.channelId });
    assert.equal(store.load({ ...scope, botId: 'fish-b' }, 1001), undefined);
    assert.ok(store.load({ ...scope, channelId: 'group-b' }, 1001));
    assert.ok(store.load({ ...scope, namespace: 'workspace-b' }, 1001));
  } finally { store.close(); }
}));

test('expiry, clock rollback, malformed persisted conditions and oversized records never restore a wait', () => fixture(async root => {
  const store = new GroupWaitStore(root);
  try {
    store.save(scope, saved()); assert.equal(store.load(scope, 61000), undefined);
    store.save(scope, saved()); assert.equal(store.load(scope, 999), undefined);
    for (const mutation of [value => { value.plan.expiresAt = 999999; }, value => { value.plan.speakerIds = ['x'.repeat(201)]; }, value => { value.plan.keyword = 'x\ny'; }]) {
      const value = saved(); mutation(value); assert.throws(() => store.save(scope, value));
    }
    const db = new DatabaseSync(join(root, 'group-waits.sqlite'));
    try {
      store.save(scope, saved());
      db.prepare('UPDATE waits SET payload=?').run(JSON.stringify({ ...saved(), extra: 'not a supported field', plan: { ...saved().plan, invented: 'not a condition' } }));
      assert.deepEqual(store.load(scope, 1001), saved());
      for (const payload of ['{bad-json', JSON.stringify({ ...saved(), plan: { ...saved().plan, speakerIds: [] } }), ' '.repeat(20000)]) {
        store.save(scope, saved()); db.prepare('UPDATE waits SET payload=?').run(payload);
        assert.equal(store.load(scope, 1001), undefined);
        assert.equal(Number(db.prepare('SELECT count(*) AS n FROM waits').get().n), 0);
      }
    } finally { db.close(); }
  } finally { store.close(); }
}));

test('storage failures do not acknowledge a new wait or a successful durable cancellation', () => fixture(async root => {
  const store = new GroupWaitStore(root); let failures = 0;
  const c = new GroupWaitController(store.persistence(scope, () => failures++), 1000);
  const t = c.begin('onebot', 'owner-user-key');
  assert.equal(c.apply(t, { action: 'wait' }, ['alice'], 'alice', 1000).state, 'waiting');
  store.close();
  assert.equal(c.apply(t, { action: 'wait', keyword: 'new' }, ['alice'], 'alice', 1001).ok, false);
  assert.equal(c.snapshot('onebot', 1001).keyword, '');
  const cancellation = c.apply(t, { action: 'cancel' }, ['alice'], 'alice', 1002);
  assert.equal(cancellation.ok, false); assert.equal(cancellation.state, 'idle');
  assert.equal(c.observe({ platform: 'onebot', userId: 'alice', text: 'new', direct: false }, 1003), 'idle');
  const next = c.begin('onebot', 'owner-user-key');
  assert.equal(c.apply(next, { action: 'wait' }, ['alice'], 'alice', 1004).ok, false);
  assert.ok(failures >= 3);
}));

test('capacity rejects a new scope, permits an existing scope update, and expired waits release space', () => fixture(async root => {
  const store = new GroupWaitStore(root);
  try {
    for (let i = 0; i < 1000; i++) store.save({ ...scope, channelId: `bounded-${i}` }, saved());
    assert.throws(() => store.save(scope, saved()), /容量/);
    const updated = { ...scope, channelId: 'bounded-0' };
    store.save(updated, saved(1001));
    assert.equal(store.load(updated, 1002).createdAt, 1001);
    store.save(scope, saved(61000));
    assert.equal(store.load(scope, 61000).createdAt, 61000);
    assert.equal(store.load({ ...scope, channelId: 'bounded-1' }, 61000), undefined);
  } finally { store.close(); }
}));

test('restored matches do not bypass disabled participation or quiet hours', () => fixture(async root => {
  const store = new GroupWaitStore(root); const clock = { now: Date.parse('2026-10-30T04:00:00Z') };
  try {
    for (const patch of [{ enabled: false }, { quietHours: [0, 23] }]) {
      store.save(scope, saved(clock.now - 1000));
      let classified = 0, responded = 0;
      const c = new GroupConversationCoordinator(services(store, clock, { classify: async () => { classified++; assert.fail('normal policy must block before classification'); } }));
      try {
        const p = getGroupChatPolicy({ activity: 'active', quietHours: [0, 0], ...patch });
        const pending = c.receive(message('blocked-match', { text: 'abc' }), p, async () => { responded++; assert.fail('must not respond'); });
        await c.flush(scope.channelId);
        assert.equal((await pending).reply, false);
        assert.equal(classified, 0); assert.equal(responded, 0);
        assert.equal(store.load(scope, clock.now), undefined, 'a blocked matching event still consumes its wait once');
      } finally { c.close(); }
    }
  } finally { store.close(); }
}));

test('coordinator shutdown preserves a deadline, unrelated input stays quiet after reopening and matching input uses ordinary policy', () => fixture(async root => {
  let store = new GroupWaitStore(root); const clock = { now: 1000 }; let classifications = 0, responses = 0, schedules = 0;
  const make = () => new GroupConversationCoordinator(services(store, clock, {
    schedule: () => { schedules++; return 1; },
    classify: async () => { classifications++; return { reply: true, addressed: 'none', related: 'my_thread', reason: 'context', source: 'human', loopRisk: false }; }
  }));
  const respond = async batch => {
    responses++;
    if (batch.anchor.id === 'start') assert.equal(batch.onGroupWait({ action: 'wait', keyword: '找到了', seconds: 60 }).state, 'waiting');
    else assert.equal(batch.anchor.waitEvent.kind, 'matched');
    return { delivered: true, replyText: '等资料。' };
  };
  let c = make();
  try {
    const first = c.receive(message('start', { direct: true }), policy, respond); await c.flush(scope.channelId); await first;
    const initialClassifications = classifications;
    c.close(); store.close(); store = new GroupWaitStore(root); clock.now = 30000; c = make();
    const oldSchedules = schedules;
    assert.equal((await c.receive(message('other'), policy, respond)).reply, false);
    assert.equal(classifications, initialClassifications); assert.equal(responses, 1); assert.equal(schedules, oldSchedules);
    const matched = c.receive(message('found', { text: '找到了' }), policy, respond); await c.flush(scope.channelId); await matched;
    assert.equal(responses, 2); assert.equal(classifications, initialClassifications + 1); assert.equal(store.load(scope, 30001), undefined);
  } finally { c.close(); store.close(); }
}));

test('cancellation and reset can clear saved waits before a restarted coordinator has received a message', () => fixture(async root => {
  const store = new GroupWaitStore(root); const clock = { now: 1001 }; const c = new GroupConversationCoordinator(services(store, clock));
  try {
    store.save(scope, saved()); store.save({ ...scope, botId: 'fish-b' }, saved());
    const current = { platform: scope.platform, botId: scope.botId };
    assert.equal(c.cancelPending(scope.channelId, 'wrong-owner', false, current), false);
    assert.equal(c.cancelPending(scope.channelId, 'owner-user-key', false, current), true);
    assert.equal(store.load(scope, 1001), undefined); assert.ok(store.load({ ...scope, botId: 'fish-b' }, 1001));
    c.clear(scope.channelId);
    assert.equal(store.load({ ...scope, botId: 'fish-b' }, 1001), undefined);
  } finally { c.close(); store.close(); }
}));

test('a restored wait respects conversation disablement and cannot leak across a workspace switch', () => fixture(async root => {
  const previous = globalThis.__config; const store = new GroupWaitStore(root); const clock = { now: 1001, namespace: scope.namespace };
  const c = new GroupConversationCoordinator(services(store, clock));
  try {
    store.save(scope, saved());
    globalThis.__config = { value: { 'alemonjs-agent-link': { modules: { disabled: ['conversation'] } } } };
    await c.receive(message('disabled'), { ...policy, enabled: false }, async () => assert.fail('must not reply'));
    assert.equal(store.load(scope, 1001), undefined);
    globalThis.__config = previous;
    let oldCallback;
    const first = c.receive(message('start', { direct: true }), policy, async batch => { oldCallback = batch.onGroupWait; batch.onGroupWait({ action: 'wait' }); return { delivered: true }; });
    await c.flush(scope.channelId); await first;
    clock.namespace = 'workspace-b';
    assert.equal(oldCallback({ action: 'wait' }).ok, false);
    clock.namespace = scope.namespace;
    assert.equal(oldCallback({ action: 'wait' }).ok, false, 'a rejected callback cannot revive even before a new scope receives messages');
    clock.namespace = 'workspace-b';
    assert.equal((await c.receive(message('other-workspace'), { ...policy, enabled: false }, async () => assert.fail('must not reply'))).reply, false);
    assert.ok(store.load(scope, 1002));
    assert.equal(store.load({ ...scope, namespace: clock.namespace }, 1002), undefined);
    clock.namespace = scope.namespace;
    await c.receive(message('returned-workspace'), { ...policy, enabled: false }, async () => assert.fail('must not reply'));
    assert.equal(oldCallback({ action: 'wait' }).ok, false, 'returning to an old workspace must not revive an old callback');
  } finally { globalThis.__config = previous; c.close(); store.close(); }
}));

test('production coordinator wiring saves and cancels a scoped wait in an isolated data directory', () => fixture(async root => {
  const previous = globalThis.__config, oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': {
    workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), stateBackend: 'local',
    groupChat: { quietHours: [0, 0] }, modules: { disabled: ['mood'] }
  } } };
  globalThis.fetch = async () => assert.fail('no model or platform HTTP calls');
  const { getDSHConfig } = await import('../lib/dsh/runtime-config.js');
  const { groupConversations } = await import('../lib/social/groups.js');
  const { getGroupWaitStore, groupWaitNamespace } = await import('../lib/social/group-wait-store.js');
  const { getGroupSettingsStore } = await import('../lib/social/group-settings.js');
  const config = getDSHConfig(); const target = { ...scope, namespace: groupWaitNamespace(config) };
  try {
    const pending = groupConversations.receive(message('production-start', { direct: true, addressed: true, explicitCommand: true }), policy, async batch => {
      assert.equal(batch.onGroupWait({ action: 'wait', keyword: '已完成', seconds: 60 }).state, 'waiting');
      return { delivered: true };
    });
    await new Promise(resolve => setImmediate(resolve));
    await groupConversations.flush(scope.channelId); await pending;
    const store = getGroupWaitStore(config);
    assert.equal(store.load(target, Date.now()).plan.keyword, '已完成');
    groupConversations.close();
    assert.ok(store.load(target, Date.now()), 'normal coordinator shutdown must preserve valid waits');
    assert.equal(groupConversations.cancelPending(scope.channelId, 'owner-user-key', false, { platform: scope.platform, botId: scope.botId }), true);
    assert.equal(store.load(target, Date.now()), undefined);
    let oldCallback;
    const again = groupConversations.receive(message('save-again', { direct: true, addressed: true, explicitCommand: true }), policy, async batch => {
      oldCallback = batch.onGroupWait;
      assert.equal(batch.onGroupWait({ action: 'wait', seconds: 60 }).ok, true);
      return { delivered: true };
    });
    await new Promise(resolve => setImmediate(resolve)); await groupConversations.flush(scope.channelId); await again;
    assert.ok(store.load(target, Date.now()));
    globalThis.__config.value['alemonjs-agent-link'].modules.disabled = ['mood', 'chat-history'];
    assert.equal(oldCallback({ action: 'wait' }).ok, false);
    await groupConversations.receive(message('history-disabled'), { ...policy, enabled: false }, async () => assert.fail('must not reply'));
    assert.equal(store.load(target, Date.now()), undefined);
    const ephemeral = groupConversations.receive(message('ephemeral', { direct: true, addressed: true, explicitCommand: true }), policy, async batch => {
      assert.equal(batch.onGroupWait({ action: 'wait', seconds: 60 }).ok, true);
      return { delivered: true };
    });
    await new Promise(resolve => setImmediate(resolve)); await groupConversations.flush(scope.channelId); await ephemeral;
    assert.equal(store.load(target, Date.now()), undefined, 'disabled history allows in-memory waiting without saving keywords');
    globalThis.__config.value['alemonjs-agent-link'].modules.disabled = ['mood'];
    await groupConversations.receive(message('history-enabled-again'), { ...policy, enabled: false }, async () => assert.fail('must not reply'));
    assert.equal(oldCallback({ action: 'wait' }).ok, false);
  } finally {
    groupConversations.close(); getGroupWaitStore(config).close(); delete globalThis.__agentLinkGroupWaitStore__;
    getGroupSettingsStore(config).close();
    globalThis.__config = previous; globalThis.fetch = oldFetch;
  }
}));
