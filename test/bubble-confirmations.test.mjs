import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestApp} from 'alemonjs/testing';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

for (const [name,command] of [['history-clear','清除聊天记录'],['agent-purge','清除群数据']]) {
 test(`${command}: real cancel, strict grammar and scoped confirmations`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'bubble-confirm-'));
  const app=createTestApp({config:{'alemonjs-agent-link':{stateBackend:'local',workspaceRoot:join(root,'workspaces'),dshHomeRoot:join(root,'homes')}}});
  const handler=(await import(`../lib/response/${name}/res.js`)).default;
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  const run=async(args=[],overrides={})=>{
    const event=app.events.groupMessage({}, {Platform:'qq-bot',BotId:'bot-a',UserId:'owner-a',UserKey:'same-key',ChannelId:'g',IsMaster:true,
      MessageText:`/${command} ${args.join(' ')}`,__route:{key:command,text:command,rawArgs:args,parsedArgs:[],params:{}},...overrides});
    // Set IDs after the fixture has derived defaults, to test the actual event identity.
    Object.assign(event,overrides);
    const result=await app.runHandler(handler,event,'alemonjs-agent-link');
    assert.equal(result.errors.length,0);
    return {text:JSON.stringify(result.messages),actions:JSON.stringify(result.actions.map(item=>item.request.payload?.params))};
  };
  try {
    const preview=await run();
    assert.match(preview.actions,new RegExp(`/${command} 确认`));
    assert.match(preview.actions,new RegExp(`/${command} 取消`));
    assert.doesNotMatch(preview.actions,/BT.group/);
    for(const identity of [{UserId:'owner-b'},{Platform:'other'},{BotId:'bot-b'},{ChannelId:'other-group'}]) {
      assert.match((await run(['确认'],identity)).text,/失效|过期|不匹配/);
    }
    assert.match((await run(['确认','额外参数'])).text,/没有识别/);
    assert.match((await run(['取消'])).text,/已取消/);
    assert.match((await run(['确认'])).text,/失效|过期|不匹配/);
    await run();now+=60001;
    assert.match((await run(['确认'])).text,/失效|过期|不匹配/);
    const denied=await run([],{IsMaster:false,Role:'member',IsAdmin:false});
    assert.doesNotMatch(denied.actions,new RegExp(`/${command} 确认`));
  } finally {Date.now=originalNow;await app.dispose();await rm(root,{recursive:true,force:true});}
 });
}
