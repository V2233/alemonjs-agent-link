import test from 'node:test';
import assert from 'node:assert/strict';
import { getGroupChatPolicy } from '../lib/social/group-policy.js';

test('大肥鱼默认使用最积极的群聊活跃度，但仍可显式覆盖', () => {
  const policy = getGroupChatPolicy({});

  assert.equal(policy.activity, 'active');
  assert.equal(policy.interjectChance, 0.45);
  assert.equal(policy.cooldownSeconds, 30);
  assert.equal(policy.maxPerHour, 16);
  assert.equal(policy.minRecentMessages, 2);
  assert.equal(policy.minRelevance, 0.15);
  assert.equal(policy.engagedSeconds, 600);

  const tuned = getGroupChatPolicy({ interjectChance: 0.9, maxPerHour: 3, cooldownSeconds: 5 });
  assert.equal(tuned.interjectChance, 0.9);
  assert.equal(tuned.maxPerHour, 3);
  assert.equal(tuned.cooldownSeconds, 5);
  assert.equal(tuned.activity, 'active');
});

test('quiet and balanced presets are selectable, and per-group overrides keep explicit fields', () => {
  const quiet = getGroupChatPolicy({ activity: 'quiet' });
  assert.equal(quiet.interjectChance, 0.08);
  assert.equal(quiet.cooldownSeconds, 180);
  assert.equal(quiet.minRelevance, 0.35);

  const balanced = getGroupChatPolicy({ activity: 'balanced' });
  assert.equal(balanced.interjectChance, 0.25);
  assert.equal(balanced.cooldownSeconds, 60);

  const group = getGroupChatPolicy({ activity: 'balanced', overrides: { g1: { activity: 'quiet', interjectChance: 0.2 } } }, 'g1');
  assert.equal(group.activity, 'quiet');
  assert.equal(group.interjectChance, 0.2);
  assert.equal(group.cooldownSeconds, 180);

  const other = getGroupChatPolicy({ activity: 'balanced', overrides: { g1: { activity: 'quiet' } } }, 'g2');
  assert.equal(other.activity, 'balanced');
  assert.equal(other.interjectChance, 0.25);
});

test('invalid activity is rejected', () => {
  assert.throws(() => getGroupChatPolicy({ activity: 'hyper' }), /groupChat 配置无效/u);
});
