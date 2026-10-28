import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { getGroupChatPolicy, groupActivityPresets } from '../lib/social/group-policy.js';
import { GroupSettingsStore, activityCeiling, normalizeGroupSetting, settingsToPolicy } from '../lib/social/group-settings.js';
import { PersonaStore } from '../lib/companion/personas.js';

const base = Date.parse('2026-10-26T10:00:00+08:00');
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-settings-'));
  let now = base;
  const store = new GroupSettingsStore(root, () => now);

  return { root, store, advance: ms => (now += ms) };
};

test('群设置按群保存、带审计，重置后回到空设置', async () => {
  const f = await setup();

  try {
    assert.deepEqual(f.store.get('qq', 'g1'), {});
    assert.deepEqual(f.store.update('qq', 'g1', 'admin-1', { activity: 'quiet' }), { ok: true });
    assert.equal(f.store.get('qq', 'g1').activity, 'quiet');
    assert.equal(f.store.get('qq', 'g2').activity, undefined, '不同群互不影响');

    const audit = f.store.audit('qq', 'g1');

    assert.equal(audit.length, 1);
    assert.equal(audit[0].field, 'activity');
    assert.equal(audit[0].after, 'quiet');
    assert.equal(audit[0].operator, 'admin-1');

    f.store.reset('qq', 'g1', 'admin-1');
    assert.deepEqual(f.store.get('qq', 'g1'), {});
    assert.equal(f.store.audit('qq', 'g1')[0].field, 'reset');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('群设置限制每日次数与单字段冷却', async () => {
  const f = await setup();

  try {
    assert.deepEqual(f.store.update('qq', 'g1', 'admin', { activity: 'quiet' }, { daily: 2, cooldownMs: 0 }), { ok: true });
    assert.deepEqual(f.store.update('qq', 'g1', 'admin', { maxPerHour: 4 }, { daily: 2, cooldownMs: 0 }), { ok: true });
    const blocked = f.store.update('qq', 'g1', 'admin', { maxPerHour: 3 }, { daily: 2, cooldownMs: 0 });

    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /今天已经改过 2 次/u);

    f.advance(86400000);
    assert.equal(f.store.update('qq', 'g1', 'admin', { maxPerHour: 3 }, { daily: 5, cooldownMs: 10_000 }).ok, true);
    const cooling = f.store.update('qq', 'g1', 'admin', { maxPerHour: 2 }, { daily: 5, cooldownMs: 10_000 });

    assert.equal(cooling.ok, false);
    assert.match(cooling.reason, /改得太快/u);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('群设置校验：档位、静默、上限与词表', () => {
  assert.equal(normalizeGroupSetting('activity', 'quiet'), 'quiet');
  assert.equal(normalizeGroupSetting('activity', '默认'), undefined);
  assert.throws(() => normalizeGroupSetting('activity', '疯狂'), /强度只能是/u);
  assert.deepEqual(normalizeGroupSetting('quietHours', '1-8'), [1, 8]);
  assert.equal(normalizeGroupSetting('quietHours', '关闭'), undefined);
  assert.throws(() => normalizeGroupSetting('quietHours', '25-3'), /静默时段/u);
  assert.equal(normalizeGroupSetting('maxPerHour', '6'), 6);
  assert.throws(() => normalizeGroupSetting('maxPerHour', '101'), /每小时上限/u);
  assert.deepEqual(normalizeGroupSetting('interests', '吃饭，游戏'), ['吃饭', '游戏']);
  assert.throws(() => normalizeGroupSetting('interests', `/${'a'.repeat(41)}`), /不超过/u);
});

test('群设置叠加在配置与默认值之间，配置显式值与按群覆盖优先', () => {
  const quiet = getGroupChatPolicy({}, 'g1', settingsToPolicy({ activity: 'quiet' }));

  assert.equal(quiet.activity, 'quiet');
  assert.equal(quiet.maxPerHour, groupActivityPresets.quiet.maxPerHour);
  assert.equal(quiet.cooldownSeconds, groupActivityPresets.quiet.cooldownSeconds);

  const locked = getGroupChatPolicy({ maxPerHour: 9 }, 'g1', settingsToPolicy({ maxPerHour: 3 }));

  assert.equal(locked.maxPerHour, 9, '主人显式写入的字段不被群设置覆盖');

  const overridden = getGroupChatPolicy({ overrides: { g1: { maxPerHour: 2 } } }, 'g1', settingsToPolicy({ maxPerHour: 8 }));

  assert.equal(overridden.maxPerHour, 2, '按群配置覆盖群设置');

  assert.equal(activityCeiling('quiet'), groupActivityPresets.quiet.maxPerHour);
  assert.equal(settingsToPolicy({ interests: ['猫'] }).interests[0], '猫');
});

test('群追加人设只出现在本群提示词里，私聊与其他群不受影响', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-scope-'));
  const config = getDSHConfig({
    workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'),
    stateBackend: 'local',
    persona: 'dafeiyu'
  });
  const store = new PersonaStore(root);

  try {
    store.appendScope({ platform: 'qq', channelId: 'g1' }, '本群可以叫我咕噜。', 'admin');
    assert.equal(store.scopeAdditions({ platform: 'qq', channelId: 'g1' }), '本群可以叫我咕噜。');
    assert.equal(store.scopeAdditions({ platform: 'qq', channelId: 'g2' }), '');

    const group = await store.systemPrompt(config, { platform: 'qq', channelId: 'g1', private: false, owner: false });

    assert.match(group, /本群管理员追加的人设/u);
    assert.match(group, /本群可以叫我咕噜/u);
    assert.ok(group.indexOf('本群管理员追加的人设') < group.indexOf('本群可以叫我咕噜'));

    const other = await store.systemPrompt(config, { platform: 'qq', channelId: 'g2', private: false, owner: false });

    assert.doesNotMatch(other, /本群管理员追加的人设/u);

    const privatePrompt = await store.systemPrompt(config, { platform: 'qq', channelId: 'private:["qq","u1"]', private: true, owner: true });

    assert.doesNotMatch(privatePrompt, /本群管理员追加的人设/u);

    store.clearScopeAdditions({ platform: 'qq', channelId: 'g1' });
    assert.equal(store.scopeAdditions({ platform: 'qq', channelId: 'g1' }), '');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('唤醒词与禁语词按群生效，禁语等长遮盖且不区分大小写', async () => {
  const f = await setup();
  const config = getDSHConfig({
    workspaceRoot: join(f.root, 'work'),
    dshHomeRoot: join(f.root, 'home'),
    stateBackend: 'local',
    groupWakeNames: ['肥鱼']
  });
  const { bannedWordsFor, getGroupSettingsStore, maskBannedWords, wakeNamesFor } = await import('../lib/social/group-settings.js');
  const store = getGroupSettingsStore(config);

  try {
    assert.deepEqual(wakeNamesFor(config, 'g1', 'qq'), ['肥鱼']);
    assert.deepEqual(store.update('qq', 'g1', 'admin', { wakeNames: ['小鱼'], bannedWords: ['脚本', 'AI'] }, { daily: 10, cooldownMs: 0 }), {
      ok: true
    });
    assert.deepEqual(wakeNamesFor(config, 'g1', 'qq'), ['肥鱼', '小鱼'], '群补充追加在全局词表后');
    assert.deepEqual(wakeNamesFor(config, 'g2', 'qq'), ['肥鱼'], '其他群不受影响');
    assert.deepEqual(bannedWordsFor(config, 'g1', 'qq'), ['脚本', 'AI']);
    assert.deepEqual(bannedWordsFor(config, 'g2', 'qq'), []);
    assert.equal(maskBannedWords('用脚本代替AI吧', ['脚本', 'ai']), '用＊＊代替＊＊吧');
    assert.equal(maskBannedWords('普通句子', []), '普通句子');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('唤醒词与禁语词有独立的上限校验', async () => {
  const { maxBannedWords, maxWakeNames, normalizeGroupSetting } = await import('../lib/social/group-settings.js');

  assert.equal(normalizeGroupSetting('wakeNames', '小鱼').length, 1);
  assert.throws(
    () =>
      normalizeGroupSetting(
        'wakeNames',
        Array.from({ length: maxWakeNames + 1 }, (_, i) => `w${i}`)
      ),
    /最多/u
  );
  assert.throws(
    () =>
      normalizeGroupSetting(
        'bannedWords',
        Array.from({ length: maxBannedWords + 1 }, (_, i) => `b${i}`)
      ),
    /最多/u
  );
});

test('群语音策略：可以关语音与自动语音，作用域按群', async () => {
  const f = await setup();
  const config = getDSHConfig({ workspaceRoot: join(f.root, 'work'), dshHomeRoot: join(f.root, 'home'), stateBackend: 'local' });
  const { getGroupSettingsStore, groupVoicePolicy } = await import('../lib/social/group-settings.js');
  const store = getGroupSettingsStore(config);

  try {
    assert.deepEqual(groupVoicePolicy(config, 'g1', 'qq'), { allowed: true, auto: true });
    assert.deepEqual(store.update('qq', 'g1', 'admin', { voiceEnabled: false, voiceAuto: false }, { daily: 10, cooldownMs: 0 }), { ok: true });
    assert.deepEqual(groupVoicePolicy(config, 'g1', 'qq'), { allowed: false, auto: false });
    assert.deepEqual(groupVoicePolicy(config, 'g2', 'qq'), { allowed: true, auto: true }, '其他群不受影响');
    store.update('qq', 'g1', 'admin', { voiceEnabled: true }, { daily: 10, cooldownMs: 0 });
    assert.deepEqual(groupVoicePolicy(config, 'g1', 'qq'), { allowed: true, auto: false });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('自动语音尊重群设置：关闭后 planExpression 不再选语音', async () => {
  const f = await setup();
  const config = getDSHConfig({
    workspaceRoot: join(f.root, 'work'),
    dshHomeRoot: join(f.root, 'home'),
    stateBackend: 'local',
    modules: { settings: { expression: { automatic: true, voiceChance: 1 } } }
  });
  const { getGroupSettingsStore } = await import('../lib/social/group-settings.js');
  const { planExpression } = await import('../lib/companion/expression.js');
  const store = getGroupSettingsStore(config);
  const media = { tts: { voice: 'test-voice' } };

  try {
    assert.equal(planExpression(config, { platform: 'qq', channelId: 'g1' }, 'msg-1', media).voice, true);
    store.update('qq', 'g1', 'admin', { voiceAuto: false }, { daily: 10, cooldownMs: 0 });
    assert.equal(planExpression(config, { platform: 'qq', channelId: 'g1' }, 'msg-1', media).voice, false);
    assert.equal(planExpression(config, { platform: 'qq', channelId: 'g2' }, 'msg-1', media).voice, true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
