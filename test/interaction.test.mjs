import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { InteractionStore, interactionSignal } from '../lib/companion/interaction.js';
const scope = { platform: 'qq', botId: 'bot', channelId: 'group', userId: 'alice' };
const hour = 3600000;
test('explicit self reports exclude quotes, hypothetical scenes, other people and negation', () => {
  for (const text of ['他说我困了', '如果我困了', '扮演一个困了的人', '“我口渴”', '他累了', '帮我翻译我困了'])
    assert.equal(interactionSignal(text), 'none', text);
  assert.equal(interactionSignal('我困了'), 'rest');
  assert.equal(interactionSignal('我口渴'), 'water');
  assert.equal(interactionSignal('我不困'), 'awake');
});
test('delivered care has cooldown, unresolved needs expire, user feedback survives reopening and purge', () => {
  const root = mkdtempSync(join(tmpdir(), 'interaction-'));
  const path = join(root, 'state.sqlite');
  let now = 100 * hour;
  let store = new InteractionStore(path, () => now);
  try {
    assert.equal(store.observe(scope, '我困了', '1').reason, 'eligible');
    // A failed/absent delivery never consumes the opportunity.
    assert.equal(store.decision(scope).reason, 'eligible');
    store.delivered(scope, '先去睡吧');
    assert.equal(store.observe(scope, '我口渴', '2').reason, 'cooldown');
    assert.equal(store.decision({ ...scope, userId: 'bob' }).reason, 'no-current-evidence');
    assert.equal(store.decision({ ...scope, botId: 'other' }).reason, 'no-current-evidence');
    assert.equal(store.decision({ ...scope, channelId: 'other' }).reason, 'no-current-evidence');
    now += 5 * hour;
    assert.equal(store.decision(scope).reason, 'no-current-evidence');
    assert.equal(store.observe(scope, '我口渴', '3').reason, 'eligible');
    assert.equal(store.observe(scope, '已经喝了', '4').reason, 'no-current-evidence');
    store.observe(scope, '别催我了', '5');
    store.close();
    store = new InteractionStore(path, () => now);
    assert.equal(store.observe(scope, '我困了', '6').reason, 'declined');
    store.observe(scope, '可以提醒我', '7');
    assert.equal(store.observe(scope, '我准备睡了', '8').reason, 'resting');
    now += 9 * hour;
    assert.equal(store.decision(scope).reason, 'no-current-evidence');
    store.observe(scope, '别催我', '9');
    store.purgeHash(createHash('sha256').update(scope.channelId).digest('hex'));
    assert.equal(store.decision(scope).reason, 'no-current-evidence');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('negative/third-party phrases never reopen reminders or invent sleep', () => {
  assert.equal(interactionSignal('不可以提醒我'), 'mute');
  assert.equal(interactionSignal('不可以催我'), 'mute');
  assert.equal(interactionSignal('别催我睡觉了'), 'mute');
  for (const text of ['他说可以提醒我', '你去睡了？', '别跟他说晚安', '我还没准备睡了', '她已经喝了水', '/我困了']) {
    assert.equal(interactionSignal(text), 'none', text);
  }
});

test('water, sleep, roleplay and real care receipts have independent transitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'interaction-transitions-'));
  const path = join(root, 'state.sqlite');
  let now = 100 * hour;
  let store = new InteractionStore(path, () => now);
  let sequence = 0;
  const say = text => store.observe(scope, text, String(++sequence));
  try {
    say('我准备睡了');
    const sleepId = String(sequence);
    assert.equal(say('已经喝了水').reason, 'resting');
    assert.equal(say('我睡不着').reason, 'no-current-evidence');
    assert.equal(store.observe(scope, '我准备睡了', sleepId).reason, 'no-current-evidence');
    say('我口渴');
    assert.equal(say('我不困').need, 'water');
    store.delivered(scope, '我先去喝水');
    assert.equal(store.decision(scope).reason, 'eligible');
    store.delivered(scope, '不用喝水');
    assert.equal(store.decision(scope).reason, 'eligible');
    store.delivered(scope, '喝两口水润润');
    assert.equal(say('我口渴').reason, 'cooldown');
    now += 5 * hour;
    say('我困了');
    say('别催我');
    say('我口渴');
    assert.equal(say('可以提醒我').reason, 'no-current-evidence');
    assert.equal(say('我们来角色扮演').reason, 'roleplay');
    store.close();
    store = new InteractionStore(path, () => now);
    assert.equal(say('我准备睡了').reason, 'roleplay');
    assert.equal(store.snapshot(scope).restingUntil, 0);
    assert.equal(say('我口渴').reason, 'roleplay');
    store.delivered(scope, '喝点水');
    assert.equal(say('不演了').reason, 'no-current-evidence');
    assert.equal(say('我困了').reason, 'eligible');
    say('我们来角色扮演');
    assert.equal(say('别催我').reason, 'declined');
    now += 3 * hour;
    assert.equal(store.decision(scope).roleplay, false);
    assert.equal(store.decision(scope).reason, 'declined');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
