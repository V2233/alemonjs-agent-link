import test from 'node:test';
import assert from 'node:assert/strict';
import {extractApiKeys,KeyIntake} from '../lib/credentials/key-intake.js';
import {createTestApp} from 'alemonjs/testing';
import handler from '../lib/response/key-intake/res.js';

test('recognizes pasted keys despite template text, punctuation and duplicate occurrences',()=>{
 const key='sk-real1234567890';
 assert.deepEqual(extractApiKeys(`/我的钥匙 私聊 添加 sk-你的key ${key}`),[key]);
 assert.deepEqual(extractApiKeys(`这是我的密钥：${key}。${key}`),[key]);
 assert.deepEqual(extractApiKeys('sk-你的Key sk-your-api-key'),[]);
 assert.deepEqual(extractApiKeys(`sk-${'a'.repeat(241)}`),[]);
 assert.equal(extractApiKeys(`${key} sk-other12345678`).length,2);
});

test('pending offers are owner-bound, expiring, single-use and safe against double clicks',async()=>{
 let now=0;const intake=new KeyIntake(()=>now);let count=0;
 const id=intake.offer('a','sk-secret12345678');
 await assert.rejects(intake.confirm('b',id,async()=>{count++;}));
 let release;const task=intake.confirm('a',id,async key=>{assert.equal(key,'sk-secret12345678');count++;await new Promise(resolve=>release=resolve);});
 await assert.rejects(intake.confirm('a',id,async()=>{count++;}),/重复/);
 release();await task;assert.equal(count,1);
 await assert.rejects(intake.confirm('a',id,async()=>{count++;}));
 const expired=intake.offer('a','sk-secret12345678');now=300001;
 await assert.rejects(intake.confirm('a',expired,async()=>{count++;}));
 const retry=intake.offer('a','sk-secret12345678');
 await assert.rejects(intake.confirm('a',retry,async()=>{throw new Error('storage unavailable');}));
 await intake.confirm('a',retry,async()=>{count++;});assert.equal(count,2);
});

test('intake consumes key messages, never reflects the secret, and exposes both purposes without a bar',async()=>{
 const app=createTestApp();const key='sk-real1234567890';
 try {
  const run=(privateChat,text)=>app.runHandler(handler,(privateChat?app.events.privateMessage:app.events.groupMessage)({}, {Platform:'qq-bot',UserId:'u',BotId:'b',MessageText:text}),'alemonjs-agent-link');
  const privateResult=await run(true,`/我的钥匙 私聊 添加 sk-你的key ${key}`);
  assert.equal(privateResult.errors.length,0);assert.equal(privateResult.nextCalls.length,0);
  const rendered=JSON.stringify(privateResult.messages);
  assert.match(rendered,/添加到私聊/);assert.match(rendered,/添加到群聊/);
  assert.doesNotMatch(JSON.stringify(privateResult.actions.map(action=>action.request.payload.params)),/sk-real1234567890|BT.group/);
  assert.match(JSON.stringify(privateResult.actions),/autoEnter/);
  const group=await run(false,key);assert.equal(group.nextCalls.length,0);assert.match(JSON.stringify(group.messages),/请私聊/);
  const normal=await run(true,'你好');assert.equal(normal.nextCalls.length,1);
  const multiple=await run(true,`${key} sk-other12345678`);assert.match(JSON.stringify(multiple.messages),/一次只发送一把/);
 } finally {await app.dispose();}
});

test('pasted keys and selection tickets are excluded from conversation capture',async()=>{const {isPersonalKeyCommand}=await import('../lib/credentials/personal.js');assert.equal(isPersonalKeyCommand('这里是 sk-actual12345678'),true);assert.equal(isPersonalKeyCommand('/添加钥匙 私聊 abc'),true);assert.equal(isPersonalKeyCommand('你好'),false);});

test('unknown or malformed selection tickets give recovery guidance without exposing secrets',async()=>{
 const app=createTestApp();
 try {
  for(const ticket of ['invalid','a'.repeat(32)]){
   const result=await app.runHandler(handler,app.events.privateMessage({}, {Platform:'qq-bot',UserId:'u',BotId:'b',MessageText:`/添加钥匙 私聊 ${ticket}`}),'alemonjs-agent-link');
   assert.equal(result.errors.length,0);
   assert.equal(result.nextCalls.length,0);
   assert.match(JSON.stringify(result.messages),/失效|未完成/);
   assert.match(JSON.stringify(result.messages),/重新.*Key/);
   assert.doesNotMatch(JSON.stringify(result.messages),/已添加本人钥匙|sk-/);
  }
 } finally {await app.dispose();}
});
