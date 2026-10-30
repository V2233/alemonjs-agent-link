import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupConversationCoordinator } from '../lib/social/group-conversation.js';
import { getGroupChatPolicy } from '../lib/social/group-policy.js';
import { buildMessageContext } from '../lib/social/message-context.js';

const policy = getGroupChatPolicy({ activity: 'active', quietHours: [0, 0], interjectChance: 1, cooldownSeconds: 0, interests: [] });
const message = (platform, botId, id = 'same-message-id', extra = {}) => ({
  channelId: 'same-channel-id', platform, botId, id, userId: 'alice', userKey: 'alice', name: 'Alice', owner: false,
  text: '肥鱼在吗', direct: true, addressed: true, ...extra
});
const harness = extra => {
  const timers = new Map(); let sequence = 0;
  const coordinator = new GroupConversationCoordinator({
    now: () => Date.parse('2026-10-30T04:00:00Z'), random: () => 0,
    schedule: run => { const id = ++sequence; timers.set(id, run); return id; }, unschedule: id => timers.delete(id), ...extra
  });

  return { coordinator, timers };
};

test('same-number channels and message IDs on different platforms never merge or deduplicate each other', async () => {
  const { coordinator, timers } = harness(); const batches = [];
  const respond = async batch => { batches.push(batch); return { delivered: true }; };
  try {
    const first = coordinator.receive(message('onebot', 'fish'), policy, respond);
    const second = coordinator.receive(message('other-platform', 'fish'), policy, respond);
    assert.equal(timers.size, 2);
    await coordinator.flush('same-channel-id'); await Promise.all([first, second]);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map(batch => batch.messages.map(m => m.platform)), [['onebot'], ['other-platform']]);
  } finally { coordinator.close(); }
});

test('bot identity, including the normalized event context and unknown identity, separates batches', async () => {
  const { coordinator } = harness(); const bots = [];
  const respond = async batch => { bots.push(batch.anchor.botId ?? batch.anchor.messageContext?.conversation.botId ?? ''); assert.equal(batch.messages.length, 1); return { delivered: true }; };
  try {
    const context = buildMessageContext({ Platform: 'onebot', ChannelId: 'same-channel-id', BotId: 'fish-b' }, [], 'mention');
    const pending = [
      coordinator.receive(message('onebot', 'fish-a'), policy, respond),
      coordinator.receive(message('onebot', undefined, 'same-message-id', { messageContext: context }), policy, respond),
      coordinator.receive(message('onebot', undefined), policy, respond)
    ];
    await coordinator.flush('same-channel-id'); await Promise.all(pending);
    assert.deepEqual(bots, ['fish-a', 'fish-b', '']);
  } finally { coordinator.close(); }
});

test('scheduled flush and policy lookup use only their own scoped state and the raw channel ID', async () => {
  const policies = [], batches = [];
  const { coordinator, timers } = harness({ getPolicy: (channelId, platform) => { policies.push([channelId, platform]); return policy; } });
  const respond = async batch => { batches.push(batch.anchor.platform); return { delivered: true }; };
  try {
    const first = coordinator.receive(message('onebot', 'fish'), policy, respond);
    const second = coordinator.receive(message('other-platform', 'fish'), policy, respond);
    const run = timers.values().next().value;
    run(); await first;
    assert.deepEqual(batches, ['onebot']);
    await coordinator.flush('same-channel-id', { platform: 'other-platform', botId: 'fish' }); await second;
    assert.deepEqual(batches, ['onebot', 'other-platform']);
    assert.deepEqual(policies, [['same-channel-id', 'onebot'], ['same-channel-id', 'other-platform']]);
  } finally { coordinator.close(); }
});

test('a direct conversation with another bot cannot interrupt a pending wait', async () => {
  let classifications = 0; const events = [];
  const { coordinator } = harness({ classify: async () => { classifications++; return { reply: true, addressed: 'none', related: 'my_thread', reason: 'context', source: 'human', loopRisk: false }; } });
  const respond = async batch => {
    events.push(batch);
    if (batch.anchor.id === 'start') assert.equal(batch.onGroupWait({ action: 'wait', keyword: '找到了', seconds: 60 }).state, 'waiting');
    return { delivered: true, replyText: '等找到资料再说。' };
  };
  try {
    const first = coordinator.receive(message('onebot', 'fish-a', 'start'), policy, respond);
    await coordinator.flush('same-channel-id'); await first;
    const other = coordinator.receive(message('onebot', 'fish-b', 'other'), policy, respond);
    await coordinator.flush('same-channel-id'); await other;
    const ignored = await coordinator.receive(message('onebot', 'fish-a', 'not-yet', { text: '还没找到', direct: false, addressed: false }), policy, respond);
    assert.equal(ignored.reply, false); assert.equal(classifications, 0);
    const found = coordinator.receive(message('onebot', 'fish-a', 'found', { text: '找到了', direct: false, addressed: false }), policy, respond);
    await coordinator.flush('same-channel-id'); await found;
    assert.equal(events.length, 3); assert.equal(classifications, 1);
    assert.equal(events[2].anchor.waitEvent.kind, 'matched');
    assert.deepEqual(events[2].anchor.waitEvent.conditions.speakerIds, ['alice']);
  } finally { coordinator.close(); }
});

test('scoped cancellation and invalidation leave other pending bots and platforms intact', async () => {
  for (const action of ['cancel', 'invalidate', 'clear']) {
    const { coordinator } = harness(); const delivered = [];
    const respond = async batch => { delivered.push([batch.anchor.platform, batch.anchor.botId]); return { delivered: true }; };
    try {
      const pending = [
        coordinator.receive(message('onebot', 'fish-a'), policy, respond),
        coordinator.receive(message('onebot', 'fish-b'), policy, respond),
        coordinator.receive(message('other-platform', 'fish-a'), policy, respond)
      ];
      const scope = { platform: 'onebot', botId: 'fish-a' };
      if (action === 'cancel') assert.equal(coordinator.cancelPending('same-channel-id', 'alice', false, scope), true);
      else if (action === 'invalidate') coordinator.invalidateRecent('same-channel-id', scope);
      else coordinator.clear('same-channel-id', scope);
      await coordinator.flush('same-channel-id'); await Promise.all(pending);
      assert.deepEqual(delivered, [['onebot', 'fish-b'], ['other-platform', 'fish-a']], action);
    } finally { coordinator.close(); }
  }
});

test('continuation invitations belong to the bot that actually delivered the prior reply', async () => {
  const { coordinator } = harness(); const batches = [];
  const respond = async batch => { batches.push(batch); return { delivered: true, replyText: '把资料整理好再发我。' }; };
  try {
    const first = coordinator.receive(message('onebot', 'fish-a', 'start'), policy, respond);
    await coordinator.flush('same-channel-id'); await first;
    const disabled = { ...policy, enabled: false };
    const other = coordinator.receive(message('onebot', 'fish-b', 'unrelated', { text: '资料已经整理好了', direct: false, addressed: false }), disabled, respond);
    await coordinator.flush('same-channel-id');
    assert.equal((await other).reply, false, 'another bot must not acquire a direct invitation');
    assert.equal(batches.length, 1);
    const followUp = coordinator.receive(message('onebot', 'fish-a', 'follow-up', { text: '资料已经整理好了', direct: false, addressed: false }), disabled, respond);
    await coordinator.flush('same-channel-id');
    assert.equal((await followUp).reply, true);
    assert.equal(batches[1].anchor.continuation.replyText, '把资料整理好再发我。');
  } finally { coordinator.close(); }
});

test('clearing one bot rejects its late wait callback without invalidating another bot callback', async () => {
  const { coordinator } = harness(); const callbacks = new Map();
  const respond = async batch => {
    callbacks.set(batch.anchor.botId, batch.onGroupWait);
    assert.equal(batch.onGroupWait({ action: 'wait', seconds: 60 }).state, 'waiting');
    return { delivered: true };
  };
  try {
    const pending = [coordinator.receive(message('onebot', 'fish-a'), policy, respond), coordinator.receive(message('onebot', 'fish-b'), policy, respond)];
    await coordinator.flush('same-channel-id'); await Promise.all(pending);
    coordinator.clear('same-channel-id', { platform: 'onebot', botId: 'fish-a' });
    assert.equal(callbacks.get('fish-a')({ action: 'wait' }).ok, false);
    assert.equal(callbacks.get('fish-b')({ action: 'status' }).state, 'waiting');
  } finally { coordinator.close(); }
});
