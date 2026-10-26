import test from 'node:test';
import assert from 'node:assert/strict';
import { getGroupChatPolicy, decideGroupReply, isQuietHour, groupTopicRelevance } from '../lib/social/group-policy.js';
import { GroupConversationCoordinator, buildGroupBatchPrompt } from '../lib/social/group-conversation.js';

const now = Date.parse('2026-10-26T04:00:00Z');
const policy = overrides => getGroupChatPolicy({ interjectChance: 1, quietHours: [0, 0], ...overrides });
const decision = overrides =>
  decideGroupReply({
    policy: policy(),
    direct: false,
    owner: false,
    now,
    recentTimes: [now, now, now],
    replyTimes: [],
    interjectTimes: [],
    engagedUntil: 0,
    relevance: 0.8,
    random: () => 0,
    ...overrides
  });
const message = (id, overrides = {}) => ({
  channelId: 'group',
  id,
  userId: id,
  userKey: id,
  name: id,
  owner: false,
  text: '一起聊游戏',
  direct: true,
  ...overrides
});
const harness = extra => {
  let clock = now;
  let nextTimer = 0;
  const timers = new Map();
  const coordinator = new GroupConversationCoordinator({
    now: () => clock,
    random: () => 0,
    schedule: (run, ms) => {
      const id = ++nextTimer;
      timers.set(id, { run, ms });
      return id;
    },
    unschedule: id => timers.delete(id),
    ...extra
  });
  return {
    coordinator,
    timers,
    advance: ms => {
      clock += ms;
    }
  };
};

test('reply policy covers direct wake, quiet time, relevance, active windows, cooldown, engagement and burst limits', () => {
  assert.equal(decision().mode, 'interject');
  assert.equal(decision({ direct: true, relevance: 0 }).mode, 'direct');
  assert.equal(decision({ now: Date.parse('2026-10-25T18:00:00Z'), policy: policy({ quietHours: [1, 8] }) }).reply, false);
  assert.equal(decision({ policy: policy({ enabled: false }) }).reply, false);
  assert.equal(decision({ relevance: 0.1 }).reply, false);
  assert.equal(decision({ recentTimes: [now] }).reply, false);
  assert.equal(decision({ interjectTimes: [now - 1] }).reply, false);
  assert.equal(decision({ policy: policy({ maxPerHour: 1 }), interjectTimes: [now - 100000] }).reply, false);
  assert.equal(decision({ engagedUntil: now + 1, interjectTimes: [now - 1] }).mode, 'engaged');
  assert.equal(decision({ policy: policy({ burstMax: 1 }), replyTimes: [now - 1], direct: true }).reply, false);
  assert.equal(decision({ policy: policy({ burstMax: 1 }), replyTimes: [now - 1], direct: true, owner: true }).mode, 'direct');
  assert.equal(isQuietHour(23, [22, 7]), true);
  assert.equal(isQuietHour(6, [22, 7]), true);
  assert.equal(isQuietHour(12, [22, 7]), false);
  assert.equal(groupTopicRelevance(['猫 猫 猫'], ['猫']), 0.3);
  for (const invalid of [
    { interjectChance: NaN },
    { batchWindowMs: 100, maxBatchWaitMs: 99 },
    { quietHours: [0, 24] },
    { timezone: 'invalid' },
    { interests: [''] }
  ]) {
    assert.throws(() => getGroupChatPolicy(invalid));
  }
  assert.equal(getGroupChatPolicy({ overrides: { one: { enabled: false } } }, 'one').enabled, false);
});

test('debounce combines participants and preserves the last actual direct sender as authority', async () => {
  const h = harness();
  const batches = [];
  const respond = async batch => {
    batches.push(batch);
    return { delivered: true };
  };
  try {
    const first = h.coordinator.receive(message('owner', { owner: true }), policy(), respond);
    h.advance(100);
    const second = h.coordinator.receive(message('member', { owner: false }), policy(), respond);
    const third = h.coordinator.receive(message('background', { direct: false, text: '补充一点' }), policy(), respond);
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].ms, 50);
    await h.coordinator.flush('group');
    await Promise.all([first, second, third]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].anchor.userId, 'member');
    assert.equal(batches[0].anchor.owner, false);
    assert.equal(batches[0].messages.length, 3);
    assert.equal(batches[0].mode, 'direct');
    const prompt = buildGroupBatchPrompt(batches[0]);
    assert.ok(prompt.includes('m3'));
    assert.ok(prompt.includes('background'));
    assert.equal((await h.coordinator.receive(message('member'), policy(), respond)).reason, '重复消息');
  } finally {
    h.coordinator.close();
  }
});

test('continuous input is bounded by the maximum wait and active replies buffer the next segment', async () => {
  const h = harness();
  const batches = [];
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const respond = async batch => {
    batches.push(batch);
    if (batches.length === 1) await gate;
    return { delivered: true };
  };
  try {
    const first = h.coordinator.receive(message('one', { direct: false }), policy({ minRecentMessages: 1 }), respond);
    h.advance(1400);
    const more = h.coordinator.receive(message('two', { direct: false }), policy({ minRecentMessages: 1 }), respond);
    assert.equal([...h.timers.values()][0].ms, 100);
    const flushing = h.coordinator.flush('group');
    const next = h.coordinator.receive(message('three'), policy(), respond);
    assert.equal(h.timers.size, 0);
    await h.coordinator.flush('group');
    assert.equal(batches.length, 1);
    release();
    await flushing;
    await Promise.all([first, more]);
    assert.equal(h.timers.size, 1);
    await h.coordinator.flush('group');
    await next;
    assert.equal(batches.length, 2);
    assert.deepEqual(
      batches[1].messages.map(m => m.id),
      ['three']
    );
  } finally {
    release();
    h.coordinator.close();
  }
});

test('silence and failures never start engagement; failed requests can be retried', async () => {
  const h = harness();
  const p = policy({ minRecentMessages: 1, engagedSeconds: 60 });
  try {
    const silent = h.coordinator.receive(message('silent', { direct: false }), p, async () => ({ delivered: false, completed: true }));
    await h.coordinator.flush('group');
    await silent;
    const after = h.coordinator.receive(message('after', { direct: false }), p, async batch => {
      assert.equal(batch.mode, 'interject');
      return { delivered: false, completed: false };
    });
    await h.coordinator.flush('group');
    await after;
    const retry = h.coordinator.receive(message('after'), p, async () => ({ delivered: true }));
    await h.coordinator.flush('group');
    assert.equal((await retry).reply, true);
    const engaged = h.coordinator.receive(message('engaged', { direct: false }), p, async batch => {
      assert.equal(batch.mode, 'engaged');
      return { delivered: true };
    });
    await h.coordinator.flush('group');
    await engaged;
  } finally {
    h.coordinator.close();
  }
});

test('pending cancellation respects sender ownership and reset discards pending context', async () => {
  const h = harness();
  try {
    const pending = h.coordinator.receive(message('one'), policy(), async () => assert.fail('cancelled batch ran'));
    assert.equal(h.coordinator.cancelPending('group', 'other'), false);
    assert.equal(h.coordinator.cancelPending('group', 'one'), true);
    await pending;
    assert.equal(h.timers.size, 0);
    const again = h.coordinator.receive(message('two'), policy(), async () => assert.fail('reset batch ran'));
    h.coordinator.clear('group');
    await again;
    assert.equal(h.timers.size, 0);
    await h.coordinator.flush('group');
  } finally {
    h.coordinator.close();
  }
});

test('flush rechecks changed policy and burst limits after the preceding response', async () => {
  let current = policy({ minRecentMessages: 1 });
  const h = harness({ getPolicy: () => current });
  try {
    const pending = h.coordinator.receive(message('one', { direct: false }), current, async () => assert.fail('disabled batch ran'));
    current = policy({ enabled: false });
    await h.coordinator.flush('group');
    await pending;
    const explicit = h.coordinator.receive(message('two'), current, async () => ({ delivered: true }));
    await h.coordinator.flush('group');
    await explicit;
    current = policy({ burstMax: 1 });
    assert.equal((await h.coordinator.receive(message('three'), current, async () => assert.fail('burst batch ran'))).reply, false);
  } finally {
    h.coordinator.close();
  }
});

test('reset while a full segment is flushing resolves incoming requests without scheduling retired context', async () => {
  const h = harness();
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const p = policy({ maxBatchMessages: 1 });
  let calls = 0;
  try {
    const first = h.coordinator.receive(message('first'), p, async () => {
      calls++;
      await gate;
      return { delivered: true };
    });
    const overflow = h.coordinator.receive(message('overflow'), p, async () => assert.fail('retired request ran'));
    h.coordinator.clear('group');
    release();
    await first;
    assert.equal((await overflow).reply, false);
    assert.equal(calls, 1);
    assert.equal(h.timers.size, 0);
  } finally {
    release();
    h.coordinator.close();
  }
});

test('semantic gate replaces random relevance and denies even explicit name calls', async () => {
  let classified = 0;
  let replied = 0;
  const h = harness({
    classify: async input => {
      classified++;
      assert.equal(input.messages[0].called, true);
      return { reply: false, reason: 'none' };
    }
  });
  const done = h.coordinator.receive(message('gate', { text: '大肥鱼别回复' }), policy(), async () => {
    replied++;
    return { delivered: true };
  });
  await h.coordinator.flush('group');
  await done;
  assert.equal(classified, 1);
  assert.equal(replied, 0);
  h.coordinator.close();
});

test('semantic gate admits useful messages without keyword or topic match and passes reason', async () => {
  let batch;
  const h = harness({ classify: async () => ({ reply: true, reason: 'open_help' }) });
  const done = h.coordinator.receive(
    message('help', { text: '这个报错该怎么处理', direct: false }),
    policy({ interjectChance: 0.01, interests: [], minRecentMessages: 100 }),
    async value => {
      batch = value;
      return { delivered: true, replyText: '请提供报错原文' };
    }
  );
  await h.coordinator.flush('group');
  await done;
  assert.equal(batch.replyReason, 'open_help');
  assert.match(buildGroupBatchPrompt(batch), /open_help/);
  h.coordinator.close();
});

test('commands bypass classification and classifier exceptions never invoke DSH', async () => {
  let calls = 0;
  let replies = 0;
  const h = harness({
    classify: async () => {
      calls++;
      throw new Error('offline');
    }
  });
  const respond = async () => {
    replies++;
    return { delivered: true };
  };
  const a = h.coordinator.receive(message('cmd', { explicitCommand: true }), policy(), respond);
  await h.coordinator.flush('group');
  await a;
  assert.equal(calls, 0);
  assert.equal(replies, 1);
  const b = h.coordinator.receive(message('ordinary'), policy(), respond);
  await h.coordinator.flush('group');
  await b;
  assert.equal(calls, 1);
  assert.equal(replies, 1);
  h.coordinator.close();
});

test('cancel during classification prevents a late positive verdict from replying', async () => {
  let resolve;
  let replies = 0;
  const h = harness({
    classify: () =>
      new Promise(done => {
        resolve = done;
      })
  });
  const done = h.coordinator.receive(message('cancel'), policy(), async () => {
    replies++;
    return { delivered: true };
  });
  const flush = h.coordinator.flush('group');
  assert.equal(h.coordinator.cancelPending('group', 'someone-else'), false);
  assert.equal(h.coordinator.cancelPending('group', 'cancel'), true);
  resolve({ reply: true, reason: 'direct_call' });
  await flush;
  await done;
  assert.equal(replies, 0);
  h.coordinator.close();
});

test('loop breaker also applies to explicit commands and owners without calling AI again', async () => {
  const h = harness();
  let replies = 0;
  const respond = async () => {
    replies++;
    return { delivered: true, replyText: '已回答你的详细问题' };
  };
  const first = h.coordinator.receive(
    message('loop1', { userId: 'peer', text: '请详细解释这一个问题', explicitCommand: true, owner: true }),
    policy(),
    respond
  );
  await h.coordinator.flush('group');
  await first;
  const second = await h.coordinator.receive(
    message('loop2', { userId: 'peer', text: '请详细解释这一个问题', explicitCommand: true, owner: true }),
    policy(),
    respond
  );
  assert.equal(second.reply, false);
  assert.equal(replies, 1);
  const bot = await h.coordinator.receive(message('bot', { isBot: true }), policy(), respond);
  assert.equal(bot.reply, false);
  h.coordinator.close();
});

test('failed delivery does not train the loop breaker to reject a retry', async () => {
  const h = harness();
  const item = message('retry-loop', { text: '请详细解释这一个失败的问题' });
  const first = h.coordinator.receive(item, policy(), async () => ({ delivered: false }));
  await h.coordinator.flush('group');
  await first;
  let replies = 0;
  const second = h.coordinator.receive(item, policy(), async () => {
    replies++;
    return { delivered: true };
  });
  await h.coordinator.flush('group');
  await second;
  assert.equal(replies, 1);
  h.coordinator.close();
});

test('explicit command has zero debounce and a trailing message cannot delay it', async () => {
  const h = harness();
  const a = h.coordinator.receive(message('command', { explicitCommand: true }), policy(), async () => ({ delivered: true }));
  assert.equal([...h.timers.values()][0].ms, 0);
  const b = h.coordinator.receive(message('background', { direct: false }), policy(), async () => ({ delivered: true }));
  assert.equal([...h.timers.values()][0].ms, 0);
  await h.coordinator.flush('group');
  await Promise.all([a, b]);
  h.coordinator.close();
});

test('latency separates local waiting, classification and response without dropping the gate', async () => {
  let timings;
  const h = harness({
    classify: async () => {
      h.advance(40);
      return { reply: true, reason: 'direct_call' };
    },
    onTiming: value => {
      timings = value;
    }
  });
  const a = h.coordinator.receive(message('timing'), policy(), async () => {
    h.advance(60);
    return { delivered: true };
  });
  assert.equal([...h.timers.values()][0].ms, 150);
  h.advance(150);
  await h.coordinator.flush('group');
  await a;
  assert.deepEqual(timings, { waitMs: 150, gateMs: 40, responseMs: 60, totalMs: 250 });
  h.coordinator.close();
});

test('lifecycle invalidation cancels classification without re-enabling a late response', async () => {
  let resolve;
  let replies = 0;
  const h = harness({
    classify: () =>
      new Promise(done => {
        resolve = done;
      })
  });
  const done = h.coordinator.receive(message('withdrawn'), policy(), async () => {
    replies++;
    return { delivered: true };
  });
  const flush = h.coordinator.flush('group');
  h.coordinator.invalidateRecent('group');
  resolve({ reply: true, reason: 'direct_call' });
  await flush;
  await done;
  assert.equal(replies, 0);
  h.coordinator.close();
});
