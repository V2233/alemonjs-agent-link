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
