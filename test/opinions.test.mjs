import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { OpinionStore } from '../lib/opinions/store.js';
test('opinions preserve attribution, caps, correction, isolation, freeze and persistence',()=>{
 const root=mkdtempSync(join(tmpdir(),'opinions-'));const path=join(root,'opinions.sqlite');let now=Date.UTC(2026,1,1);let store=new OpinionStore(path,()=>now);
 const scope={platform:'qq',channelId:'g',personaId:'dafeiyu'};
 const input={name:'QQ',kind:'software',dimension:'广告',perspective:'reported',author:'a',quote:'QQ广告太多',comment:'发言者认为QQ广告太多',delta:0};
 try {
  let row=store.record(scope,'m1',input);assert.equal(row.score,null);assert.equal(row.label,'未形成看法');
  row=store.record(scope,'m1',{...input,perspective:'inferred',comment:'根据这条反馈，对广告设计持保留态度',delta:-1});assert.equal(row.score,49);
  assert.equal(store.record(scope,'m2',{...input,perspective:'inferred',delta:-1}).recorded,false);
  assert.equal(store.list({...scope,channelId:'other'}).length,0);
  assert.throws(()=>store.record(scope,'bad',{...input,kind:'person'}),/ID/);
  assert.throws(()=>store.record(scope,'bad',{...input,perspective:'inferred',delta:-5}),/格式/);
  row=store.edit(row.id,row.revision,'revoke',row.events[0].id);assert.equal(row.score,null);assert.ok(row.events.every(e=>e.revoked));
  assert.throws(()=>store.edit(row.id,row.revision-1,'freeze'),/配置已/);
  row=store.edit(row.id,row.revision,'freeze');assert.equal(store.record(scope,'m3',{...input,quote:'QQ新观点'}).recorded,false);
  row=store.edit(row.id,row.revision,'unfreeze');
  for(let i=0;i<15;i++) row=store.record(scope,'next'+i,{...input,perspective:'inferred',quote:'QQ新的反馈'+i,delta:-1});
  assert.equal(row.score,40);
  now+=86400000;row=store.record(scope,'later',{...input,perspective:'inferred',quote:'QQ第二天的反馈',delta:1});assert.equal(row.score,41);
  store.close();store=new OpinionStore(path,()=>now);assert.equal(store.list()[0].score,41);
  const epoch=store.epoch('g');store.purgeHash(createHash('sha256').update('g').digest('hex'));assert.equal(store.epoch('g'),epoch+1);assert.equal(store.list().length,0);
  store.record(scope,'expire',input);now+=31*86400000;store.cleanup(30);assert.equal(store.list().length,0);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
