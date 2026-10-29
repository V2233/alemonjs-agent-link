import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from '../lib/memory/store.js';
import {ChatArchive} from '../lib/history/store.js';
import {consolidateSharedDialogue} from '../lib/memory/shared-consolidation.js';

test('automatic consolidation replays agreement correction cancellation and rejects fabricated evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shared-auto-'));const scope={platform:'qq',channelId:'g'};
 const archive=new ChatArchive(join(dir,'chat.sqlite'));const store=new MemoryStore(join(dir,'memory.sqlite'));
 const add=(id,text,speakerId='u')=>archive.append(scope,{id,text,speakerId,speaker:speakerId,role:'user'});
 try{
  add('1','说好了明天八点看比赛');
  await consolidateSharedDialogue(archive,store,scope,'u',async ({sources})=>[{text:'约定明天八点看比赛',state:'agreed',sourceSeqs:[sources[0].seq],evidence:'明天八点'}]);
  const original=store.sharedThreads(scope,'u')[0];
  let called=false;await consolidateSharedDialogue(archive,store,scope,'u',async()=>{called=true;return[];});assert.equal(called,false);
  add('2','改成九点');add('other','我已经完成了','other');
  await consolidateSharedDialogue(archive,store,scope,'u',async ({sources,previous})=>{
   assert.ok(sources.every(source=>source.speakerId!=='other'));
   return [{id:previous[0].id,text:'改为九点',state:'agreed',sourceSeqs:[sources.at(-1).seq],evidence:'改成九点'}];
  });
  add('3','取消这个安排');
  await assert.rejects(consolidateSharedDialogue(archive,store,scope,'u',async ({sources})=>[{id:original.id,text:'取消',state:'cancelled',sourceSeqs:[sources.at(-1).seq],evidence:'伪造原文'}]));
  assert.equal(store.sharedThreads(scope,'u')[0].state,'agreed');
  await consolidateSharedDialogue(archive,store,scope,'u',async ({sources})=>[{id:original.id,text:'安排已取消',state:'cancelled',sourceSeqs:[sources.at(-1).seq],evidence:'取消这个安排'}]);
  assert.equal(store.sharedThreads(scope,'u')[0].state,'cancelled');
  assert.equal(store.sharedThreadHistory(scope,'u',original.id).length,3);
 }finally{archive.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('long backlog is drained in bounded batches and concurrent stale extraction cannot duplicate writes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shared-backlog-'));const scope={platform:'qq',channelId:'g'};
 const archive=new ChatArchive(join(dir,'chat.sqlite'));const store=new MemoryStore(join(dir,'memory.sqlite'));
 try{
  for(let i=0;i<130;i++) archive.append(scope,{id:String(i),text:i===0?'约定第一件事':i===129?'约定最后一件事':'普通聊天',role:'user',speakerId:'u',speaker:'u'});
  const seen=[];
  const ask=async ({sources})=>{seen.push(...sources.map(s=>s.seq));return sources.filter(s=>s.text.startsWith('约定')).map(s=>({text:s.text,state:'agreed',sourceSeqs:[s.seq],evidence:s.text}));};
  const first=await consolidateSharedDialogue(archive,store,scope,'u',ask);
  assert.equal(first.hasMore,true);
  await consolidateSharedDialogue(archive,store,scope,'u',ask);
  assert.equal(store.sharedThreads(scope,'u').length,2);
  assert.equal(seen.length,130);
  archive.append(scope,{id:'new',text:'约定并发事项',role:'user',speakerId:'u',speaker:'u'});
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const delayed=consolidateSharedDialogue(archive,store,scope,'u',async input=>{await pending;return ask(input);});
  const immediate=await consolidateSharedDialogue(archive,store,scope,'u',ask);
  release();const stale=await delayed;
  assert.equal(immediate.status,'saved');assert.equal(stale.status,'stale');
  assert.equal(store.sharedThreads(scope,'u').length,3);
 }finally{archive.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('batch rollback leaves neither partial items nor an advanced checkpoint',()=>{
 const dir=mkdtempSync(join(tmpdir(),'shared-rollback-'));const store=new MemoryStore(join(dir,'memory.sqlite'));
 const scope={platform:'qq',channelId:'g'};store.observe(scope);
 const source={seq:1,speakerId:'u',speaker:'u',text:'约定事项',timestamp:Date.now()};
 try{
  const change={text:'约定事项',state:'agreed',sources:[source]};
  assert.throws(()=>store.commitSharedBatch(scope,'u',0,1,[change,{...change,id:'missing',expectedRevision:1}],store.state(scope)));
  assert.equal(store.sharedThreads(scope,'u').length,0);assert.equal(store.sharedCheckpoint(scope,'u'),0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
