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

    const hits = await store.recallSemantic(
      scope,
      '茶饮偏好',
      'u1',
      5,
      { client, weight: 0.8, maxItems: 100, signal: new AbortController().signal },
      false
    );
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

    await store.recallSemantic(
      scope,
      '茶饮偏好',
      'u1',
      5,
      { client: cached, weight: 0.8, maxItems: 100, signal: new AbortController().signal },
      false
    );
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
