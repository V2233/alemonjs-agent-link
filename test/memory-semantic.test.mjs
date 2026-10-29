import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/memory/store.js';
import { cosineSimilarity } from '../lib/memory/embedding.js';

const vector = (tea, city) => Float32Array.from([tea, city]);
const client = {
  model: 'mock-embedding',
  embed: async texts =>
    texts.map(text =>
      text.includes('龙井') || text.includes('茶饮') ? vector(1, 0.01) : text.includes('杭州') || text.includes('城市') ? vector(0.01, 1) : vector(0.5, 0.5)
    )
};

test('semantic recall finds a differently worded memory that BM25 cannot match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-memory-semantic-'));
  const store = new MemoryStore(join(root, 'memories.sqlite'), () => 1_800_000_000_000);
  const scope = { platform: 'test', channelId: 'group' };

  try {
    store.syncExplicit(scope, 'u1', [
      { id: 'a'.repeat(8), text: '主人喜欢喝龙井茶', createdAt: 1_800_000_000_000 },
      { id: 'b'.repeat(8), text: '主人住在杭州', createdAt: 1_800_000_000_000 }
    ]);
    const lexical = store.recall(scope, '茶饮偏好', 'u1', 5, false);
    assert.equal(lexical.length, 0, 'BM25 alone should not match 茶饮偏好 to 龙井茶');

    const hits = await store.recallSemantic(scope, '茶饮偏好', 'u1', 5, { client, weight: 0.8, maxItems: 100, signal: new AbortController().signal }, false);
    assert.equal(hits[0].text, '主人喜欢喝龙井茶');
    assert.ok(hits[0].score > 0);
    assert.ok(!hits.some(item => item.text === '主人住在杭州'));

    let embeddedTexts = 0;
    const cached = {
      model: 'mock-embedding',
      embed: async texts => {
        embeddedTexts = texts.length;
        return texts.map(text => (text.includes('茶饮') || text.includes('龙井') ? vector(1, 0.01) : vector(0.01, 1)));
      }
    };

    await store.recallSemantic(scope, '茶饮偏好', 'u1', 5, { client: cached, weight: 0.8, maxItems: 100, signal: new AbortController().signal }, false);
    assert.equal(embeddedTexts, 1, 'cached document vectors should not be re-embedded');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('embedding failure falls back to BM25 and still returns lexical matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentlink-memory-fallback-'));
  const store = new MemoryStore(join(root, 'memories.sqlite'), () => 1_800_000_000_000);
  const scope = { platform: 'test', channelId: 'group' };

  try {
    store.syncExplicit(scope, 'u1', [{ id: 'c'.repeat(8), text: '主人喜欢喝龙井茶', createdAt: 1_800_000_000_000 }]);
    const hits = await store.recallSemantic(
      scope,
      '龙井',
      'u1',
      5,
      {
        client: { model: 'broken', embed: async () => Promise.reject(new Error('offline')) },
        weight: 0.8,
        maxItems: 100,
        signal: new AbortController().signal
      },
      false
    );
    assert.equal(hits[0].text, '主人喜欢喝龙井茶');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cosine similarity is bounded and dimension-safe', () => {
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0])), 1);
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  assert.equal(cosineSimilarity(Float32Array.from([1]), Float32Array.from([1, 0])), 0);
});

test('semantic cache expands across turns and retains old vectors outside the new embedding budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-coverage-'));
  const store = new MemoryStore(join(root, 'memories.sqlite'));
  const scope = { platform: 'test', channelId: 'coverage' };
  try {
    store.syncExplicit(scope, 'u', [
      { id: '11111111', text: '杭州', createdAt: Date.now() },
      { id: '22222222', text: '龙井', createdAt: Date.now() - 1000 }
    ]);
    const options = { client, weight: 0.8, maxItems: 1, signal: new AbortController().signal };
    await store.recallSemantic(scope, '城市', 'u', 5, options, false);
    const second = await store.recallSemantic(scope, '茶饮', 'u', 5, options, false);
    assert.ok(second.some(item => item.text === '龙井'));
    const third = await store.recallSemantic(scope, '城市', 'u', 5, options, false);
    assert.ok(third.some(item => item.text === '杭州'));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('deletion while embedding is pending cannot return removed memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-delete-race-'));
  const store = new MemoryStore(join(root, 'memory.sqlite'));
  const scope = { platform: 'qq', channelId: 'group' };
  try {
    store.syncExplicit(scope, 'alice', [{ id: '12345678', text: '龙井茶', createdAt: Date.now() }]);
    let release;
    const pending = store.recallSemantic(scope, '茶饮', 'alice', 8, {
      client: {
        model: 'test',
        embed: () =>
          new Promise(resolve => {
            release = () => resolve([vector(1, 0), vector(1, 0)]);
          })
      },
      maxItems: 100,
      weight: 0.8,
      signal: new AbortController().signal
    });
    store.forget(scope, '12345678', 10);
    release();
    assert.deepEqual(await pending, []);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('fallback deletion barriers survive restart and retain person isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-barrier-restart-'));
  const path = join(root, 'memory.sqlite');
  const scope = { platform: 'qq', channelId: 'group' };
  let store = new MemoryStore(path);
  try {
    store.syncExplicit(scope, 'alice', [{ id: '12345678', text: '龙井茶', createdAt: Date.now() }]);
    store.forget(scope, '12345678', 12);
    store.close();
    store = new MemoryStore(path);
    assert.equal(store.fallbackAfter(scope, 'alice'), 12);
    assert.equal(store.fallbackAfter(scope, 'bob'), 0);
    assert.equal(store.fallbackAfter({ ...scope, channelId: 'other' }, 'alice'), 0);
    store.clear(scope, 20);
    store.close();
    store = new MemoryStore(path);
    assert.equal(store.fallbackAfter(scope, 'alice'), 20);
    assert.equal(store.fallbackAfter(scope, 'bob'), 20);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
