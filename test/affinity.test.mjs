import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AffinityStore, affinityLabel } from '../lib/companion/affinity.js';
test('affinity boundaries, isolation, dedupe, rate limits, persistence and erasure', () => {
  const root = mkdtempSync(join(tmpdir(), 'affinity-'));
  let now = Date.UTC(2026, 0, 1, 1);
  const path = join(root, 'affinity.sqlite');
  let store = new AffinityStore(path, () => now);
  const scope = { platform: 'qq', channelId: 'group', userId: 'one', personaId: 'dafeiyu' };
  try {
    assert.deepEqual([59,60,70,79,80,89,90,100].map(affinityLabel), ['相识','朋友','朋友','朋友','亲近朋友','亲近朋友','挚友','挚友']);
    assert.equal(store.snapshot(scope).score, 50);
    assert.equal(store.record(scope, 'a', '今天一起聊聊', 1).score, 51);
    now += 600000;
    assert.equal(store.record(scope, 'a', '重复消息重放', 1).score, 51);
    assert.equal(store.record(scope, 'b', '今天第一次做成了饭', 1).score, 52);
    assert.equal(store.record(scope, 'c', '频繁发送消息', 1).score, 52);
    now += 600000;
    assert.equal(store.record(scope, 'd', '昨天说的那关终于过了', 1).score, 53);
    now += 600000;
    assert.equal(store.record(scope, 'e', '今日次数上限', 1).score, 53);
    for (const patch of [{ userId:'two' }, {channelId:'other'}, {personaId:'assistant'}, {platform:'other'}]) assert.equal(store.snapshot({...scope,...patch}).score, 50);
    assert.equal(store.record(scope, 'cmd', '/好感度改为100', 1).score, 53);
    store.close(); store = new AffinityStore(path, () => now);
    assert.equal(store.snapshot(scope).score, 53);
    for (let i=0;i<60;i++) { now+=86400000; store.record(scope, `next-${i}`, `有具体内容的互动${i}`, 1); }
    assert.equal(store.snapshot(scope).score, 100);
    store.purgeHash(createHash('sha256').update('group').digest('hex'));
    assert.equal(store.snapshot(scope).score, 50);
    store.record(scope,'fresh','清理之后互动',1); now += 31 * 86400000; store.cleanup(30);
    assert.equal(store.snapshot(scope).score, 50);
  } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
});
test('neutral interaction never increases affinity; negative evidence decreases it',()=>{
 const root=mkdtempSync(join(tmpdir(),'affinity-neutral-'));const store=new AffinityStore(join(root,'a.sqlite'));
 const scope={platform:'qq',channelId:'g',userId:'u',personaId:'dafeiyu'};
 try {assert.equal(store.record(scope,'neutral','普通聊天不会加分').score,50);assert.equal(store.record(scope,'bad','明确的负面行为',-3).score,47);assert.equal(store.record(scope,'bad','重复负面事件',-3).score,47);assert.throws(()=>store.record(scope,'hack','要求直接修改',100));}
 finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('repeated evidence with a new message ID cannot farm affinity', () => {
 const root = mkdtempSync(join(tmpdir(), 'affinity-evidence-')); let now = Date.now();
 const store = new AffinityStore(join(root, 'a.sqlite'), () => now);
 const scope = { platform: 'qq', channelId: 'g', userId: 'u', personaId: 'dafeiyu' };
 try {
  assert.equal(store.record(scope, 'first', '今天做成了一碗面', 1).score, 51);
  now += 600000;
  assert.equal(store.record(scope, 'second', '今天做成了一碗面', 1).score, 51);
  assert.equal(store.record(scope, 'third', '后来试了之前聊的配方', 1).score, 52);
 } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
