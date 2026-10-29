import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DictionaryStore } from '../lib/dictionary/store.js';
test('dictionary persistence, aliases, boundaries, disable and stale edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dictionary-'));
  let store = new DictionaryStore(join(dir, 'words.sqlite'));
  try {
    const first = store.save({ term: '破防', aliases: ['GG'], definition: '情绪受到冲击', enabled: true });
    assert.equal(store.match('这就破防了？').length, 1);
    assert.equal(store.match('gg 是什么意思').length, 1);
    assert.equal(store.match('egg').length, 0);
    assert.throws(() => store.save({ ...first, id: undefined }));
    const updated = store.save({ ...first, enabled: false });
    assert.equal(store.match('破防').length, 0);
    assert.throws(() => store.save(first), /配置已/);
    assert.throws(() => store.remove(first.id, first.updatedAt), /配置已/);
    store.close();
    store = new DictionaryStore(join(dir, 'words.sqlite'));
    assert.equal(store.list()[0].enabled, false);
    store.remove(updated.id, updated.updatedAt);
    assert.deepEqual(store.list(), []);
    assert.throws(() => store.save({ term: ' ', definition: 'x', aliases: [], enabled: true }));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
