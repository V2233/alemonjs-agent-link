// Benchmark the candidate-validation stage, using temporary data only.
import { MemoryStore } from '../lib/memory/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = await mkdtemp(join(tmpdir(), 'memory-recall-bench-'));
const store = new MemoryStore(join(root, 'memory.sqlite'));
const scope = { platform: 'test', channelId: 'benchmark' };
const key = createHash('sha256')
  .update(JSON.stringify([scope.platform, scope.channelId]))
  .digest('hex');
const normalize = text =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, '');
try {
  store.syncExplicit(scope, 'user', [{ id: 'seed', text: 'seed', createdAt: Date.now() }]);
  const seed = store.list(scope)[0];
  store.transaction(() => {
    for (let i = 0; i < 1000; i++) store.insert(scope, { ...seed, id: `item-${i}`, text: `memory ${i}` });
  });
  const ranked = store.list(scope, { limit: 2000 }).map((item, i) => ({ ...item, score: 2000 - i }));
  const legacy = () => {
    const seen = new Set();
    return ranked
      .filter(hit => store.db.prepare("SELECT text FROM memories WHERE scope=? AND id=? AND status='active'").get(key, hit.id)?.text === hit.text)
      .filter(hit => {
        const id = `${hit.subjectId}:${normalize(hit.text)}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, 8)
      .map(hit => ({ ...store.decode(store.db.prepare('SELECT * FROM memories WHERE scope=? AND id=?').get(key, hit.id)), score: hit.score }));
  };
  const current = () => store.finishRanked(scope, ranked, 8, false);
  assert.deepEqual(current(), legacy());
  const results = { legacy: [], current: [] };
  for (let round = 0; round < 5; round++) {
    const variants = [
      ['legacy', legacy],
      ['current', current]
    ];
    if (round % 2) variants.reverse();
    for (const [name, run] of variants) {
      const start = performance.now();
      for (let i = 0; i < 30; i++) run();
      results[name].push(Number((performance.now() - start).toFixed(2)));
    }
  }
  console.log(JSON.stringify({ candidates: ranked.length, limit: 8, iterations: 30, results }, null, 2));
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
