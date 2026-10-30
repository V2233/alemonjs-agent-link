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
    assert.equal(store.list().find(word => word.id === first.id).enabled, false);
    store.remove(updated.id, updated.updatedAt);
    assert.equal(
      store.list().some(word => word.id === first.id),
      false
    );
    assert.throws(() => store.save({ term: ' ', definition: 'x', aliases: [], enabled: true }));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('默认热词一次性初始化，保留编辑、停用、删除和旧库同名词', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { dictionaryDefaults } = await import('../lib/dictionary/defaults.js');
  const dir = mkdtempSync(join(tmpdir(), 'dictionary-seed-'));
  const path = join(dir, 'words.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE words (id TEXT PRIMARY KEY, normalized TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)');
  db.prepare('INSERT INTO words VALUES (?,?,?)').run(
    'custom',
    '活人感',
    JSON.stringify({ id: 'custom', term: '活人感', aliases: [], definition: '管理员自定义', enabled: false, updatedAt: 1 })
  );
  db.close();
  let store = new DictionaryStore(path);
  try {
    assert.equal(store.list().length, dictionaryDefaults.length);
    assert.equal(store.list().find(w => w.id === 'custom').definition, '管理员自定义');
    assert.equal(store.match('活人感').length, 0);
    assert.equal(store.match('这就是我的奥德赛时期')[0].term, '人生奥德赛时期');
    assert.equal(store.match('你好').length, 0);
    const deleted = store.list().find(w => w.term === '哭哭马');
    store.remove(deleted.id, deleted.updatedAt);
    const edited = store.list().find(w => w.term === '爱你老己');
    store.save({ ...edited, definition: '新的解释', enabled: false });
    store.close();
    store = new DictionaryStore(path);
    assert.equal(store.list().length, dictionaryDefaults.length - 1);
    assert.equal(store.match('哭哭马').length, 0);
    assert.equal(store.list().find(w => w.term === '爱你老己').definition, '新的解释');
    assert.equal(store.match('爱你老己').length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
