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
    const first = store.save({ term: '词典测试词', aliases: ['GG'], definition: '情绪受到冲击', enabled: true });
    assert.equal(store.match('这就词典测试词了？').length, 1);
    assert.equal(store.match('gg 是什么意思').length, 1);
    assert.equal(store.match('egg').length, 0);
    assert.throws(() => store.save({ ...first, id: undefined }));
    const updated = store.save({ ...first, enabled: false });
    assert.equal(store.match('词典测试词').length, 0);
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

test('历史扩充升级不复活旧批次已删除词条，来源与年份完整', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { dictionarySeedBatches, dictionaryDefaults } = await import('../lib/dictionary/defaults.js');
  const { dictionaryHistory, dictionarySources } = await import('../lib/dictionary/history.js');
  const years = new Set(dictionaryHistory.map(entry => entry.year));
  for (let year = 2016; year <= 2025; year++) assert.ok(years.has(year));
  assert.equal(new Set(dictionaryDefaults.map(entry => entry.term.toLowerCase())).size, dictionaryDefaults.length);
  for (const entry of dictionaryHistory) {
    assert.ok(entry.definition.trim()); assert.ok(entry.aliases.every(alias => alias.trim()));
    assert.ok(entry.sourceIds.length > 0);
    for (const id of entry.sourceIds) assert.ok(dictionarySources[id]?.url.startsWith('https://'));
  }
  const dir = mkdtempSync(join(tmpdir(), 'dictionary-upgrade-'));
  const path = join(dir, 'words.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE words (id TEXT PRIMARY KEY, normalized TEXT UNIQUE NOT NULL, payload TEXT NOT NULL); CREATE TABLE dictionary_migrations (version TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO dictionary_migrations VALUES (?)').run(dictionarySeedBatches[0].version);
  db.prepare('INSERT INTO words VALUES (?,?,?)').run('user-edited','洪荒之力',JSON.stringify({id:'user-edited',term:'洪荒之力',aliases:[],definition:'管理员释义',enabled:false,updatedAt:1}));
  db.close();
  let store = new DictionaryStore(path);
  try {
    assert.equal(store.list().some(entry => entry.term === '哭哭马'), false);
    assert.equal(store.list().find(entry => entry.term === '洪荒之力').definition, '管理员释义');
    assert.equal(store.match('洪荒之力').length, 0);
    assert.equal(store.match('city不city啊')[0].term, 'city不city');
    assert.equal(store.match('坏猫之歌')[0].term, '坏猫之歌');
    const row = store.list().find(entry => entry.term === '电子榨菜');
    assert.equal(row, undefined); // 未核实释义的候选词不凑数导入。
    const removed = store.list().find(entry => entry.term === 'city不city'); store.remove(removed.id, removed.updatedAt);
    store.close(); store = new DictionaryStore(path);
    assert.equal(store.match('city不city').length, 0);
    assert.equal(store.list().some(entry => entry.term === '哭哭马'), false);
  } finally { store.close(); rmSync(dir, {recursive:true,force:true}); }
});
