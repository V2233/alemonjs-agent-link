import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/memory/store.js';

const scope = { platform: 'qq', channelId: 'private:one' };
const fact = (seq, text, time) => ({
  source: { seq, text, speakerId: 'one', speaker: '甲', timestamp: time },
  change: { action: 'add', text, kind: 'fact', sourceSeqs: [seq], evidence: text, tags: [], importance: 0.5, confidence: 0.9 }
});

test('private automatic capacity reserves explicit-note slots and a full store rejects the whole new plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-capacity-'));
  const store = new MemoryStore(join(root, 'memory.sqlite'));
  try {
    store.observe(scope);
    for (let start = 1; start <= 1980; start += 8) {
      const batch = Array.from({ length: Math.min(8, 1981 - start) }, (_, offset) => fact(start + offset, `偏好 ${start + offset}`, Date.now()));
      store.applyExtraction(
        scope,
        store.state(scope),
        batch.map(item => item.change),
        batch.map(item => item.source),
        start + batch.length - 1,
        false
      );
    }
    const notes = Array.from({ length: 20 }, (_, index) => ({ id: index.toString(16).padStart(8, '0'), text: `明确偏好 ${index}`, createdAt: Date.now() }));
    store.syncExplicit(scope, 'one', notes);
    assert.equal(store.list(scope, { limit: 2000 }).length, 2000);
    const incoming = fact(1981, '容量之外的事实', Date.now());
    assert.throws(() => store.applyExtraction(scope, store.state(scope), [incoming.change], [incoming.source], 1981, false), /容量/);
    assert.equal(store.state(scope).checkpoint, 1980);
    assert.equal(store.list(scope, { limit: 2000 }).filter(item => item.origin === 'explicit').length, 20);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stored facts survive reopen but expired scope data is removed before a new observation can revive it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-expiry-'));
  const path = join(root, 'memory.sqlite');
  let time = Date.now();
  let store = new MemoryStore(path, () => time);
  try {
    store.observe(scope);
    const incoming = fact(1, '喜欢杭州茶馆', time);
    store.applyExtraction(scope, store.state(scope), [incoming.change], [incoming.source], 1, false);
    const previous = store.state(scope);
    store.close();
    store = new MemoryStore(path, () => time);
    assert.equal(store.profile(scope, 'one').text, '喜欢杭州茶馆');
    time += 31 * 86400000;
    store.observe(scope);
    assert.deepEqual(store.list(scope), []);
    assert.notEqual(store.state(scope).epoch, previous.epoch);
    assert.equal(store.applyExtraction(scope, previous, [incoming.change], [incoming.source], 1, false).applied, false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
