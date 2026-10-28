import test from 'node:test';
import assert from 'node:assert/strict';
import { boundKeyGroupPolicy, decideGroupReply, defaultGroupChatPolicy, getGroupChatPolicy } from '../lib/social/group-policy.js';

test('自带 Key 的群把参与强度拉满', () => {
  const policy = boundKeyGroupPolicy({ ...defaultGroupChatPolicy });

  assert.equal(policy.boundKey, true);
  assert.equal(policy.replyGateEnabled, false);
  assert.equal(policy.cooldownSeconds, 0);
  assert.equal(policy.maxPerHour, 60);
  assert.equal(policy.interjectChance, 1);
  assert.equal(policy.minRecentMessages, 1);
  assert.equal(policy.minRelevance, 0);
  assert.equal(policy.engagedSeconds, 600);
  assert.equal(policy.burstMax, 12);
  assert.equal(policy.burstWindowSeconds, 60);
});

test('显式关闭自主参与时提权不会重新打开', () => {
  const policy = boundKeyGroupPolicy({ ...defaultGroupChatPolicy, maxPerHour: 0, interjectChance: 0 });

  assert.equal(policy.maxPerHour, 0);
  assert.equal(policy.interjectChance, 0);
});

test('按群 boundKeyElevation: false 退回普通策略', () => {
  const base = getGroupChatPolicy({ overrides: { g1: { boundKeyElevation: false } } }, 'g1');

  assert.deepEqual(boundKeyGroupPolicy(base), base);
  assert.notDeepEqual(boundKeyGroupPolicy(getGroupChatPolicy({}, 'g1')), base);
});

test('boundKeyElevation 只接受布尔值', () => {
  assert.throws(() => getGroupChatPolicy({ boundKeyElevation: 'off' }), /groupChat 配置无效/u);
});

test('拉满后普通消息直接进入插话判定，普通群仍受相关度门槛拦截', () => {
  const now = Date.parse('2026-01-01T04:00:00Z');
  const input = {
    now,
    semantic: false,
    direct: false,
    explicit: false,
    owner: false,
    relevance: 0,
    recentTimes: [now - 1000],
    replyTimes: [],
    interjectTimes: [],
    engagedUntil: 0
  };
  const elevated = decideGroupReply({
    ...input,
    policy: boundKeyGroupPolicy({ ...defaultGroupChatPolicy, quietHours: [0, 0] }),
    random: () => 0.999
  });

  assert.equal(elevated.reply, true);
  assert.equal(elevated.mode, 'interject');

  const normal = decideGroupReply({
    ...input,
    policy: { ...defaultGroupChatPolicy, quietHours: [0, 0] },
    random: () => 0
  });

  assert.equal(normal.reply, false);
  assert.equal(normal.reason, '话题相关度不足');
});

test('工具提权只加网页与文件，终端始终关闭', async () => {
  const { entitledCapabilities } = await import('../lib/social/groups.js');
  const stored = { version: 2, chat: true, web: false, files: false, terminal: false };

  assert.deepEqual(entitledCapabilities(stored, true, true), { version: 2, chat: true, web: true, files: true, terminal: false });
  assert.deepEqual(entitledCapabilities(stored, true, false), stored);
  assert.deepEqual(entitledCapabilities(stored, false, true), stored);
  assert.deepEqual(entitledCapabilities({ ...stored, terminal: true }, true, true).terminal, false);
});

test('主人可用 boundKeyTools: false 保留参与提权但关闭工具提权', () => {
  const policy = getGroupChatPolicy({ boundKeyTools: false });

  assert.equal(policy.boundKeyTools, false);
  assert.equal(boundKeyGroupPolicy(policy).cooldownSeconds, 0);
  assert.throws(() => getGroupChatPolicy({ boundKeyTools: 'off' }), /groupChat 配置无效/u);
});
