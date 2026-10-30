import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTestApp} from 'alemonjs/testing';
import handler from '../lib/response/agent-proactive/res.js';

test('saving a reading preference is not reported as completed reading or unrestricted tool access',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reading-bubble-contract-'));
 const app=createTestApp({config:{'alemonjs-agent-link':{stateBackend:'local',workspaceRoot:join(root,'work'),dshHomeRoot:join(root,'home'),modules:{settings:{bili:{dailyBrowse:true}}}}}});
 const run=async(args)=>{
  const event=app.events.privateMessage({}, {Platform:'qq-bot',BotId:'bot',UserId:'u',IsMaster:false,MessageText:`/主动搭话 ${args.join(' ')}`,__route:{key:'主动搭话',text:'主动搭话',rawArgs:args,parsedArgs:[],params:{}}});
  const result=await app.runHandler(handler,event,'alemonjs-agent-link');
  assert.equal(result.errors.length,0);
  return JSON.stringify(result.messages);
 };
 try {
  const saved=await run(['阅读','开启']);
  assert.match(saved,/偏好已保存为允许/);
  assert.match(saved,/工具权限/);
  assert.doesNotMatch(saved,/已完成阅读|已读完/);
  const menu=await run(['阅读']);
  assert.match(menu,/只保存本私聊的阅读偏好/);
  assert.match(menu,/日记和最近记录/);
 } finally {await app.dispose();await rm(root,{recursive:true,force:true});}
});
