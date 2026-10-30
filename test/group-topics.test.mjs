import { GroupTopicWorker } from '../lib/group-topics/worker.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GroupTopicStore } from '../lib/group-topics/store.js';

test('group topics persist, match interests, respect live permissions and deduplicate propagation', () => {
  const root = mkdtempSync(join(tmpdir(), 'group-topics-'));
  let store = new GroupTopicStore(root, () => 1000);
  const profile = id => ({
    id,
    platform: 'qq',
    botId: 'bot',
    channelId: id,
    positioning: '游戏攻略',
    tags: ['游戏'],
    blockedTags: [],
    enabled: true,
    shareOut: true,
    receiveShared: true
  });
  try {
    store.saveProfile(profile('a'));
    store.saveProfile(profile('b'));
    assert.throws(() => store.saveProfile({ ...profile('b'), channelId: 'different' }));
    store.saveProfile({ ...profile('c'), tags: ['编程'] });
    const topic = {
      id: 'event-1',
      origin: 'human-discussion',
      sourceGroup: 'a',
      summary: '材料消耗机制讨论',
      tags: ['游戏'],
      publishedAt: 900,
      expiresAt: 2000,
      approved: true
    };
    assert.equal(store.addTopic(topic), true);
    assert.equal(store.profiles().length, 3);
    assert.equal(store.topics().length, 1);
    assert.equal(store.addTopic(topic), false);
    assert.equal(store.candidates('a').length, 0);
    assert.equal(store.candidates('b').length, 1);
    assert.equal(store.candidates('c').length, 0);
    store.saveProfile({ ...profile('a'), shareOut: false });
    assert.equal(store.candidates('b').length, 0);
    store.saveProfile(profile('a'));
    store.saveProfile({ ...profile('b'), blockedTags: ['游戏'] });
    assert.equal(store.candidates('b').length, 0);
    store.saveProfile(profile('b'));
    store.recordDelivery('b', topic.id);
    store.close();
    store = new GroupTopicStore(root, () => 1000);
    assert.equal(store.candidates('b').length, 0);
    assert.throws(() => store.addTopic({ ...topic, id: 'bot', origin: 'bot-share' }));
    assert.throws(() => store.addTopic({ ...topic, id: 'expired', expiresAt: 999 }));
    store.removeTopic(topic.id);
    assert.equal(store.topics().length, 0);
    store.purgeHash(createHash('sha256').update('a').digest('hex'));
    assert.equal(store.profile('a'), undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('news dates use Shanghai calendar days and equivalent source URLs deduplicate', async () => {
  const { newsCandidate, recentNewsDay } = await import('../lib/group-topics/news.js');
  const now = Date.parse('2026-10-30T01:00:00+08:00');
  const first = newsCandidate('https://example.com/news?utm_source=x#part', '2026-10-29', ['游戏'], '更新公告', now);
  const second = newsCandidate('https://example.com/news', '2026-10-29', ['游戏'], '更新公告', now);
  assert.equal(first.id, second.id);
  assert.equal(recentNewsDay(Date.parse('2026-10-28T23:59:59+08:00'), now), false);
  assert.throws(() => newsCandidate('https://example.com', '2026-10-31', ['游戏'], '摘要', now));
  assert.throws(() => newsCandidate('https://example.com', '2026-02-30', ['游戏'], '摘要', now));
  assert.throws(() => newsCandidate('http://example.com', '2026-10-30', ['游戏'], '摘要', now));
});

test('video collection requires real publication dates and literal topic evidence', async () => {
  const { videoTopicCandidates } = await import('../lib/group-topics/collect.js');
  const now = Date.parse('2026-10-31T01:00:00+08:00');
  const video = { bvid: 'BV1234567890', title: '修仙游戏讨论', description: '更新内容', publishedAt: now - 3600_000 };
  const candidates = videoTopicCandidates([video], ['修仙'], now);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].origin, 'public-video');
  assert.match(candidates[0].summary, /未观看或核实/);
  assert.equal(videoTopicCandidates([{ ...video, publishedAt: undefined }], ['修仙'], now).length, 0);
  assert.equal(videoTopicCandidates([{ ...video, publishedAt: now - 3 * 86400_000 }], ['修仙'], now).length, 0);
  assert.equal(videoTopicCandidates([video], ['编程'], now).length, 0);
});

test('automatic observation creates enabled profiles, deduplicates queued messages and preserves manual opt-out', () => {
  const root = mkdtempSync(join(tmpdir(), 'group-topic-inbox-'));
  const store = new GroupTopicStore(root, () => 1000);
  const profile = {
    id: 'auto',
    platform: 'qq',
    botId: 'bot',
    channelId: 'group',
    positioning: '待分析',
    tags: [],
    blockedTags: [],
    enabled: true,
    shareOut: true,
    receiveShared: true
  };
  try {
    store.observe(profile, 'message-1', '修仙材料更新了');
    store.observe(profile, 'message-1', '修仙材料更新了');
    assert.equal(store.profile('auto').enabled, true);
    assert.equal(store.profile('auto').manual, false);
    assert.equal(store.pending('auto').length, 1);
    const pending = store.pending('auto');
    store.finishAnalysis(
      'auto',
      pending.map(row => row.id),
      'no-shareable-topic'
    );
    assert.equal(store.pending('auto').length, 0);
    assert.equal(store.activity('auto').reason, 'no-shareable-topic');
    store.saveProfile({ ...profile, enabled: false, positioning: '管理员定位' });
    store.observe(profile, 'message-2', '别覆盖设置');
    assert.equal(store.profile('auto').enabled, false);
    assert.equal(store.profile('auto').manual, true);
    assert.equal(store.pending('auto').length, 0);
    store.purgeGroup('auto');
    assert.equal(store.activity('auto').reason, 'pending');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('background worker consumes observations, learns topics, filters unsafe summaries and periodically collects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'group-topic-worker-'));
  const now = 1700000000000;
  const store = new GroupTopicStore(root, () => now);
  const config = { workspaceRoot: join(root, 'work'), aiEnabled: true };
  let collections = 0;
  const profile = {
    id: 'worker',
    platform: 'qq',
    botId: 'bot',
    channelId: 'group',
    positioning: '待分析',
    tags: [],
    blockedTags: [],
    enabled: true,
    shareOut: true,
    receiveShared: true
  };
  const worker = new GroupTopicWorker(config, {
    store,
    current: () => config,
    now: () => now,
    analyze: async () =>
      JSON.stringify({
        positioning: '修仙游戏讨论',
        tags: ['修仙'],
        topics: [
          { summary: '可以讨论材料消耗变化对玩法的影响', tags: ['修仙'] },
          { summary: '群友的手机号12345678901', tags: ['修仙'] }
        ]
      }),
    collect: async () => {
      collections++;
      return 0;
    }
  });
  try {
    store.observe(profile, 'message', '修仙更新的材料消耗变多了');
    await worker.tick();
    assert.deepEqual(store.profile(profile.id).tags, ['修仙']);
    assert.equal(store.pending(profile.id).length, 0);
    assert.equal(store.topics().length, 1);
    assert.equal(collections, 1);
    await worker.tick();
    assert.equal(collections, 1);
    store.saveProfile({ ...store.profile(profile.id), enabled: false });
    await worker.tick();
    assert.equal(collections, 1);
  } finally {
    worker.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('administrator edits during analysis invalidate results and keep the input for a later pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'topic-race-'));
  const now = 1700000000000;
  const store = new GroupTopicStore(root, () => now);
  const config = { workspaceRoot: join(root, 'work'), aiEnabled: true };
  const profile = {
    id: 'race',
    platform: 'qq',
    botId: 'b',
    channelId: 'g',
    positioning: '待分析',
    tags: [],
    blockedTags: [],
    enabled: true,
    shareOut: true,
    receiveShared: true
  };
  let resolve;
  let started;
  const ready = new Promise(r => {
    started = r;
  });
  const worker = new GroupTopicWorker(config, {
    store,
    current: () => config,
    now: () => now,
    analyze: () => {
      started();
      return new Promise(r => {
        resolve = r;
      });
    },
    collect: async () => {
      throw new Error('must not collect');
    }
  });
  try {
    store.observe(profile, 'm', '游戏讨论');
    const task = worker.tick();
    await ready;
    store.saveProfile({ ...profile, enabled: false, positioning: '管理员已关闭' });
    resolve(JSON.stringify({ positioning: '自动定位', tags: ['游戏'], topics: [{ summary: '可以讨论游戏材料', tags: ['游戏'] }] }));
    await task;
    assert.equal(store.profile('race').positioning, '管理员已关闭');
    assert.equal(store.topics().length, 0);
    assert.equal(store.pending('race').length, 1);
  } finally {
    worker.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual profile remains authoritative while failed analysis retries without dropping inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'topic-retry-'));
  let now = 1700000000000;
  const store = new GroupTopicStore(root, () => now);
  const config = { workspaceRoot: join(root, 'work'), aiEnabled: true };
  const profile = {
    id: 'manual',
    platform: 'qq',
    botId: 'b',
    channelId: 'g',
    positioning: '管理员定位',
    tags: ['游戏'],
    blockedTags: [],
    enabled: true,
    shareOut: true,
    receiveShared: true
  };
  let attempts = 0;
  const worker = new GroupTopicWorker(config, {
    store,
    current: () => config,
    now: () => now,
    analyze: async () => {
      if (++attempts === 1) throw new Error('temporary failure');
      return JSON.stringify({ positioning: '模型定位', tags: ['编程'], topics: [] });
    },
    collect: async () => 0
  });
  try {
    store.saveProfile(profile);
    store.observe(profile, 'm', '最近聊编程');
    await worker.tick();
    assert.equal(store.pending(profile.id).length, 1);
    await worker.tick();
    assert.equal(attempts, 1);
    now += 300001;
    await worker.tick();
    assert.equal(attempts, 2);
    assert.equal(store.pending(profile.id).length, 0);
    assert.deepEqual(store.profile(profile.id).tags, ['游戏']);
    assert.equal(store.profile(profile.id).positioning, '管理员定位');
    assert.ok(store.runs(profile.id).some(row => row.reason.includes('失败')));
    assert.ok(store.runs(profile.id).some(row => row.reason.includes('分析完成')));
  } finally {
    worker.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
