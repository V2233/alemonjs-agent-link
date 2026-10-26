import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../lib/memory/store.js';
import { rankMemories, tokenizeMemory } from '../lib/memory/retrieval.js';

const scope = { platform: 'qq', channelId: 'group' };
const source = (seq, text, speakerId = 'one') => ({ seq, text, speakerId, speaker: speakerId, timestamp: Date.now() });
const change = (seq, text, extra = {}) => ({
  action: 'add',
  text,
  kind: 'fact',
  sourceSeqs: [seq],
  evidence: text,
  tags: [],
  importance: 0.5,
  confidence: 0.95,
  ...extra
});
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'memory-store-'));
  const store = new MemoryStore(join(root, 'memory.sqlite'));
  store.observe(scope);
  try {
    await run(store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
};
const add = (store, seq, text, subject = 'one', extra = {}) =>
  store.applyExtraction(scope, store.state(scope), [change(seq, text, extra)], [source(seq, text, subject)], seq, false);

test('Chinese and English retrieval matches terms, boosts the current person and accounts for decay and recall days', () => {
  assert.deepEqual(tokenizeMemory('喜欢猫 Python'), ['喜欢', '欢猫', 'python']);
  const now = Date.now();
  const base = {
    id: 'one',
    subjectId: 'one',
    text: '喜欢喝茶',
    tags: ['茶'],
    importance: 0.5,
    confidence: 0.95,
    updatedAt: now - 30 * 86400000,
    lastRecalledAt: 0,
    recallDays: 0
  };
  const hits = rankMemories([base, { ...base, id: 'two', subjectId: 'two' }, { ...base, id: 'irrelevant', text: '喜欢猫', tags: [] }], '喝茶', 'one', now);
  assert.equal(hits[0].id, 'one');
  assert.equal(hits.length, 2);
  const stronger = rankMemories([{ ...base, id: 'often', recallDays: 20 }, base], '喝茶', 'one', now);
  assert.equal(stronger[0].id, 'often');
});

test('facts stay scoped; profiles and recall logs carry the actual person and retained sources', () =>
  fixture(store => {
    add(store, 1, '喜欢喝茶');
    add(store, 2, '喜欢喝咖啡', 'two');
    assert.equal(store.recall(scope, '喝茶', 'one')[0].sourceRefs[0].seq, 1);
    assert.equal(store.profile(scope, 'one').text, '喜欢喝茶');
    assert.equal(store.profile(scope, 'two').text, '喜欢喝咖啡');
    assert.deepEqual(store.recall({ ...scope, platform: 'other' }, '喝茶', 'one'), []);
    assert.deepEqual(store.recall({ ...scope, channelId: 'other' }, '喝茶', 'one'), []);
    const id = store.recall(scope, '喝茶', 'one')[0].id;
    assert.equal(store.list(scope).find(item => item.id === id).recallDays, 1);
    assert.ok(store.recalls(scope)[0].ids.includes(id));
  }));

test('corrections and merges are reversible across multiple versions without reviving conflicting active facts', () =>
  fixture(store => {
    add(store, 1, '住在杭州');
    const original = store.list(scope)[0];
    add(store, 2, '搬到苏州', 'one', { action: 'replace', targetId: original.id });
    const second = store.list(scope, { status: 'active' })[0];
    add(store, 3, '喜欢附近的公园', 'one', { action: 'merge', targetId: second.id });
    assert.equal(store.list(scope, { status: 'active' })[0].text, '搬到苏州；喜欢附近的公园');
    assert.equal(store.restore(scope, original.id), true);
    assert.deepEqual(
      store.list(scope, { status: 'active' }).map(item => item.text),
      ['住在杭州']
    );
    assert.equal(store.restore(scope, second.id), true);
    assert.deepEqual(
      store.list(scope, { status: 'active' }).map(item => item.text),
      ['搬到苏州']
    );
    assert.equal(store.profile(scope, 'one').text, '搬到苏州');
  }));

test('source validation rolls back whole plans and does not rewrite another person or explicit facts', () =>
  fixture(store => {
    add(store, 1, '喜欢茶');
    const old = store.list(scope)[0];
    const before = store.state(scope);
    assert.throws(() => store.applyExtraction(scope, before, [change(2, '新资料'), change(999, '伪造来源')], [source(2, '新资料')], 2, false));
    assert.equal(store.list(scope).length, 1);
    assert.equal(store.state(scope).checkpoint, before.checkpoint);
    assert.throws(() =>
      store.applyExtraction(
        scope,
        store.state(scope),
        [change(3, '喜欢咖啡', { action: 'replace', targetId: old.id })],
        [source(3, '喜欢咖啡', 'other')],
        3,
        false
      )
    );
    store.syncExplicit(scope, 'one', [{ id: '12345678', text: '偏好简短回答', createdAt: Date.now() }]);
    assert.throws(() =>
      store.applyExtraction(scope, store.state(scope), [change(4, '偏好长篇', { action: 'replace', targetId: '12345678' })], [source(4, '偏好长篇')], 4, false)
    );
    assert.equal(store.list(scope, { status: 'active' }).length, 2);
  }));

test('deletion removes related versions, prevents stale writes, and purge epochs prevent resurrection after recreation', () =>
  fixture(store => {
    add(store, 1, '住在杭州');
    const first = store.list(scope)[0];
    add(store, 2, '搬到苏州', 'one', { action: 'replace', targetId: first.id });
    const running = store.state(scope);
    assert.equal(store.forget(scope, first.id, 10), true);
    assert.deepEqual(store.list(scope), []);
    assert.deepEqual(store.recalls(scope), []);
    assert.equal(store.applyExtraction(scope, running, [change(3, '迟到资料')], [source(3, '迟到资料')], 3, false).applied, false);
    assert.equal(store.state(scope).checkpoint, 10);
    const beforePurge = store.state(scope);
    store.purgeHash(createHash('sha256').update(scope.channelId).digest('hex'));
    store.observe(scope);
    assert.notEqual(store.state(scope).epoch, beforePurge.epoch);
    assert.equal(store.applyExtraction(scope, beforePurge, [change(11, '旧任务')], [source(11, '旧任务')], 11, false).applied, false);
  }));

test('checkpoints reject concurrent extraction commits and unchanged explicit sync preserves recall strength', () =>
  fixture(store => {
    const guard = store.state(scope);
    assert.equal(store.applyExtraction(scope, guard, [change(1, '喜欢茶')], [source(1, '喜欢茶')], 1, false).applied, true);
    assert.equal(store.applyExtraction(scope, guard, [change(2, '喜欢咖啡')], [source(2, '喜欢咖啡')], 2, false).applied, false);
    const notes = [{ id: '12345678', text: '偏好短回复', createdAt: Date.now() }];
    store.syncExplicit(scope, 'one', notes);
    store.recall(scope, '短回复', 'one');
    const revision = store.state(scope).revision;
    store.syncExplicit(scope, 'one', notes);
    assert.equal(store.state(scope).revision, revision);
    assert.equal(store.list(scope).find(item => item.id === '12345678').recallDays, 1);
    store.clear(scope, 8);
    assert.equal(store.state(scope).checkpoint, 8);
  }));
