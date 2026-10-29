import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatArchive } from '../lib/history/store.js';

test('episode source replay preserves agreement, correction, cancellation and participant identities across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'episode-'));
  const path = join(dir, 'history.sqlite');
  const scope = {platform:'qq',channelId:'group'};
  let archive = new ChatArchive(path);
  try {
    const now = Date.now();
    const entries = [
      ['u1','user','甲','明天提醒我看比赛',now-86400000],
      ['a1','assistant','fish','要设在晚上八点吗？',now-86399000],
      ['u2','user','甲','按你说的',now-86398000],
      ['u3','user','乙','我是九点，别弄混了',now-86397000],
      ['u4','user','甲','改一下，我说的是明天九点',now-86396000],
      ['u5','user','甲','昨天那个安排取消了',now-2000],
      ['a2','assistant','fish','取消好了',now-1000]
    ];
    for (const [id,role,speakerId,text,timestamp] of entries) archive.append(scope,{id,role,speakerId,speaker:speakerId,text,timestamp});
    archive.append({...scope,channelId:'elsewhere'},{id:'secret',role:'user',speakerId:'甲',speaker:'甲',text:'隔离消息'});
    const first = archive.dialogueBatch(scope,0,3);
    assert.equal(first.hasMore,true);
    archive.close(); archive = new ChatArchive(path);
    const rest = archive.dialogueBatch(scope,first.checkpoint,100,first.upper);
    const all = [...first.sources,...rest.sources];
    assert.deepEqual(all.map(row=>row.text),entries.map(row=>row[3]));
    assert.equal(all[3].speakerId,'乙');
    assert.equal(all.at(-1).evidenceType,'assistant_statement');
    assert.match(rest.notice,/不能当作工具成功证明/);
    assert.equal(rest.hasMore,false);
    assert.throws(()=>archive.dialogueBatch(scope,0,101));
  } finally {archive.close();rmSync(dir,{recursive:true,force:true});}
});

test('character-limited pagination has no dropped sources and freezes the upper bound', () => {
  const dir = mkdtempSync(join(tmpdir(),'episode-budget-'));
  const archive = new ChatArchive(join(dir,'history.sqlite'));
  const scope = {platform:'qq',channelId:'group'};
  try {
    for(let i=0;i<20;i++) archive.append(scope,{id:String(i),role:'user',speakerId:'u',speaker:'u',text:'字'.repeat(2000)});
    const first = archive.dialogueBatch(scope,0,40);
    assert.equal(first.sources.length,8);
    assert.ok(first.sources.every(row=>row.truncated));
    archive.append(scope,{id:'new',role:'user',speakerId:'u',speaker:'u',text:'分页期间新来的'});
    const seen=[...first.sources];let page=first;
    while(page.hasMore){page=archive.dialogueBatch(scope,page.checkpoint,40,first.upper);seen.push(...page.sources);}
    assert.equal(seen.length,20);assert.equal(new Set(seen.map(row=>row.seq)).size,20);
  } finally {archive.close();rmSync(dir,{recursive:true,force:true});}
});

test('cross-day shared dialogue recall survives restart and respects speaker, scope and execution evidence', () => {
  const dir=mkdtempSync(join(tmpdir(),'shared-recall-'));
  const path=join(dir,'history.sqlite'); const scope={platform:'qq',channelId:'group'};
  let archive=new ChatArchive(path);
  try {
    const timestamp=Date.now()-86400000;
    archive.append(scope,{id:'u1',role:'user',speakerId:'甲',speaker:'甲',text:'明天提醒我看比赛',timestamp});
    archive.append(scope,{id:'a1',role:'assistant',speakerId:'fish',speaker:'fish',text:'晚上八点，我记下了。',sourceMessageId:'u1',timestamp:timestamp+1});
    archive.append(scope,{id:'u2',role:'user',speakerId:'乙',speaker:'乙',text:'明天提醒我看比赛',timestamp});
    archive.append(scope,{id:'a2',role:'assistant',speakerId:'fish',speaker:'fish',text:'已经安排九点',sourceMessageId:'u2',timestamp:timestamp+2});
    archive.close();archive=new ChatArchive(path);
    const recalled=archive.recallDialogues(scope,'甲','昨天那个比赛安排');
    assert.equal(recalled.length,1);assert.equal(recalled[0].replyMessageId,'a1');
    assert.equal(recalled[0].evidenceType,'conversation_only');
    assert.equal(archive.recallDialogues({...scope,channelId:'other'},'甲','比赛').length,0);
    assert.equal(archive.recallDialogues(scope,'甲','比赛','明天提醒我看比赛').length,0);
    const afterCompression=archive.recallDialogues(scope,'甲','按你说的');
    assert.equal(afterCompression[0].userMessageId,'u1');
    assert.equal(afterCompression[0].match,'recent');
  } finally {archive.close();rmSync(dir,{recursive:true,force:true});}
});
