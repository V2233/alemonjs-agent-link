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

test('群设置不限制修改次数，连续修改都生效并留审计', async () => {
  const f = await setup();

  try {
    for (let index = 0; index < 15; index += 1) {
      assert.deepEqual(f.store.update('qq', 'g1', 'admin', { maxPerHour: index % 5 }), { ok: true });
    }
    assert.equal(f.store.get('qq', 'g1').maxPerHour, 4);
    assert.equal(f.store.audit('qq', 'g1', 50).length, 15);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('群设置校验：档位、静默、上限与词表', () => {
  assert.equal(normalizeGroupSetting('activity', 'quiet'), 'quiet');
  assert.equal(normalizeGroupSetting('activity', '默认'), undefined);
  assert.throws(() => normalizeGroupSetting('activity', '疯狂'), /强度只能是/u);
  assert.deepEqual(normalizeGroupSetting('quietHours', '1-8'), [1, 8]);
  assert.deepEqual(normalizeGroupSetting('quietHours', '关闭'), [0, 0]);
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
    store.setScopeAdditions({ platform: 'qq', channelId: 'g1' }, '本群可以叫我咕噜。', 'admin');
    assert.equal(store.scopeAdditions({ platform: 'qq', channelId: 'g1' }), '本群可以叫我咕噜。');
    store.setScopeAdditions({ platform: 'qq', channelId: 'g1' }, '本群说话随意一点。', 'admin');
    assert.equal(store.scopeAdditions({ platform: 'qq', channelId: 'g1' }), '本群说话随意一点。', '重新发送是整体覆盖，不是累加');
    assert.equal(store.scopeAdditions({ platform: 'qq', channelId: 'g2' }), '');

    const group = await store.systemPrompt(config, { platform: 'qq', channelId: 'g1', private: false, owner: false });

    assert.match(group, /本群管理员追加的人设/u);
    assert.match(group, /本群说话随意一点/u);
    assert.ok(group.indexOf('本群管理员追加的人设') < group.indexOf('本群说话随意一点'));

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
    assert.deepEqual(store.update('qq', 'g1', 'admin', { wakeNames: ['小鱼'], bannedWords: ['脚本', 'AI'] }), {
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
    assert.deepEqual(store.update('qq', 'g1', 'admin', { voiceEnabled: false, voiceAuto: false }), { ok: true });
    assert.deepEqual(groupVoicePolicy(config, 'g1', 'qq'), { allowed: false, auto: false });
    assert.deepEqual(groupVoicePolicy(config, 'g2', 'qq'), { allowed: true, auto: true }, '其他群不受影响');
    store.update('qq', 'g1', 'admin', { voiceEnabled: true });
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
    modules: { settings: { mood: { baseline: 80 }, expression: { automatic: true, voiceChance: 1 } } }
  });
  const { getGroupSettingsStore } = await import('../lib/social/group-settings.js');
  const { planExpression } = await import('../lib/companion/expression.js');
  const store = getGroupSettingsStore(config);
  const media = { tts: { voice: 'test-voice' } };

  try {
    assert.equal(
      planExpression(config, { platform: 'qq', channelId: 'g1' }, 'audio-one', media, {
        userText: '终于考上了，太开心了',
        private: true,
        now: Date.UTC(2026, 9, 29, 4)
      }).voice,
      true
    );
    store.update('qq', 'g1', 'admin', { voiceAuto: false });
    assert.equal(
      planExpression(config, { platform: 'qq', channelId: 'g1' }, 'audio-one', media, {
        userText: '终于考上了，太开心了',
        private: true,
        now: Date.UTC(2026, 9, 29, 4)
      }).voice,
      false
    );
    assert.equal(
      planExpression(config, { platform: 'qq', channelId: 'g2' }, 'audio-one', media, {
        userText: '终于考上了，太开心了',
        private: true,
        now: Date.UTC(2026, 9, 29, 4)
      }).voice,
      true
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('静默关闭与恢复默认分开，非法时段和上限不被截断接受', () => {
  const off = normalizeGroupSetting('quietHours', '关闭');
  assert.deepEqual(getGroupChatPolicy({}, 'g', settingsToPolicy({ quietHours: off })).quietHours, [0, 0]);
  assert.equal(normalizeGroupSetting('quietHours', '默认'), undefined);
  assert.equal(normalizeGroupSetting('quietHours', '恢复'), undefined);
  for (const value of ['-1-8', '1.5-8', '1-8abc', '1:30-8:30', '100-8', [1.5, 8], ['1', '8']]) {
    assert.throws(() => normalizeGroupSetting('quietHours', value));
  }
  for (const value of ['-1', '1.5', 'abc4', '4次', '', '1e2', null]) {
    assert.throws(() => normalizeGroupSetting('maxPerHour', value));
  }
  assert.equal(normalizeGroupSetting('maxPerHour', 0), 0);
});

test('同一毫秒的审计按最新写入排序，跨平台设置与清理隔离', async () => {
  const f = await setup();
  try {
    f.store.update('qq', 'g1', 'a', { voiceEnabled: false });
    f.store.update('qq', 'g1', 'a', { voiceAuto: false });
    f.store.update('onebot', 'g1', 'b', { activity: 'active' });
    assert.equal(f.store.audit('qq', 'g1')[0].field, 'voiceAuto');
    f.store.reset('qq', 'g1', 'a');
    assert.equal(f.store.audit('qq', 'g1')[0].field, 'reset');
    assert.equal(f.store.get('onebot', 'g1').activity, 'active');
    f.store.purge('qq', 'g1');
    assert.deepEqual(f.store.audit('qq', 'g1'), []);
    assert.equal(f.store.audit('onebot', 'g1').length, 1);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('存储层拒绝非法字段值，失败不写入配置或审计', async () => {
  const f = await setup();
  try {
    for (const patch of [{ maxPerHour: -1 }, { quietHours: [24, 8] }, { activity: 'invalid' }, { voiceAuto: 'invalid' }]) {
      assert.equal(f.store.update('qq', 'g', 'admin', patch).ok, false);
    }
    assert.deepEqual(f.store.get('qq', 'g'), {});
    assert.deepEqual(f.store.audit('qq', 'g'), []);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
