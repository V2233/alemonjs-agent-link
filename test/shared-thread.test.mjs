import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const awaitHash = value => createHash('sha256').update(value).digest('hex');
import {MemoryStore} from '../lib/memory/store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('persistent shared thread replays agreement correction cancellation with provenance and isolation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'shared-thread-'));const path=join(dir,'memory.sqlite');
 const scope={platform:'qq',channelId:'group'};let clock=Date.now();let store=new MemoryStore(path,()=>clock);
 const source=(seq,text)=>({seq,text,speakerId:'甲',speaker:'甲',timestamp:clock});
 try{
  const first=store.recordSharedThread(scope,'甲',{text:'我们约定明天八点看比赛',state:'agreed',sources:[source(1,'就明天八点吧')]});
  clock+=86400000;store.close();store=new MemoryStore(path,()=>clock);
  assert.equal(store.sharedThreads(scope,'甲')[0].id,first.id);
  const corrected=store.recordSharedThread(scope,'甲',{id:first.id,expectedRevision:1,text:'改成九点',state:'agreed',sources:[source(2,'改成九点')]});
  assert.equal(corrected.previousRevision,1);
  assert.throws(()=>store.recordSharedThread(scope,'甲',{id:first.id,expectedRevision:1,text:'旧请求覆盖',state:'agreed',sources:[source(3,'八点')]}));
  store.recordSharedThread(scope,'甲',{id:first.id,expectedRevision:2,text:'比赛安排取消',state:'cancelled',sources:[source(4,'取消了')]});
  assert.equal(store.sharedThreads(scope,'甲')[0].state,'cancelled');
  assert.deepEqual(store.sharedThreadHistory(scope,'甲',first.id).map(item=>item.revision),[3,2,1]);
  assert.deepEqual(store.sharedThreads(scope,'乙'),[]);
  assert.deepEqual(store.sharedThreads({...scope,channelId:'other'},'甲'),[]);
  assert.throws(()=>store.recordSharedThread(scope,'甲',{text:'工具成功',state:'completed',sources:[source(5,'完成了')]}));
  assert.equal(store.sharedThreadHistory(scope,'甲',first.id)[0].evidenceType,'conversation_only');
  assert.throws(()=>store.linkSharedExecution(scope,'甲',first.id,3,'missing','fish'));
  store.recordDiary(scope,{key:'diary',subjectId:'fish',text:'我好像安排好了',tags:[]});
  const diary=store.list(scope,{subjectId:'fish'}).find(item=>item.origin==='diary');
  assert.throws(()=>store.linkSharedExecution(scope,'甲',first.id,3,diary.id,'fish'));
  store.recordExperience(scope,{key:'read',subjectId:'fish',text:'实际读取了比赛介绍，未创建提醒',tags:[]});
  const event=store.list(scope,{subjectId:'fish'}).find(item=>item.origin==='event');
  const linked=store.linkSharedExecution(scope,'甲',first.id,3,event.id,'fish');
  assert.equal(linked.state,'cancelled');
  assert.equal(linked.execution.text,'实际读取了比赛介绍，未创建提醒');
  assert.equal(linked.revision,4);
  assert.throws(()=>store.linkSharedExecution(scope,'乙',first.id,4,event.id,'fish'));
  store.purgeHash(awaitHash(scope.channelId));
  assert.deepEqual(store.sharedThreads(scope,'甲'),[]);

 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
