import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerTerminalAllowed, intelligenceAccess, intelligenceProfiles, readIntelligenceLevel, saveIntelligenceLevel } from '../lib/agent/intelligence.js';
const identity = {platform:'test',channelId:'group-a',userId:'u',owner:false,private:false};
test('key entitlement does not confer group management or terminal authority',()=>{
  assert.equal(intelligenceAccess(identity,true).canEdit,false);
  assert.equal(intelligenceAccess({...identity,admin:true},true).canEdit,true);
  assert.equal(intelligenceAccess({...identity,admin:true},false).canEdit,false);
  assert.equal(intelligenceAccess({...identity,private:true},true).canEdit,true);
  assert.equal(intelligenceAccess(identity,false).defaultLevel,'标准');
  assert.equal(intelligenceAccess({...identity,owner:true},false).defaultLevel,'深度');
  assert.ok(intelligenceProfiles.专研.maxRounds > intelligenceProfiles.深度.maxRounds);
});
test('settings survive rereads, are scoped and do not apply after entitlement loss',async()=>{
  const root=await mkdtemp(join(tmpdir(),'intelligence-'));
  const config={workspaceRoot:join(root,'workspaces')};
  const owner={...identity,owner:true};
  try{
    await saveIntelligenceLevel(config,owner,'专研');
    assert.equal(readIntelligenceLevel(config,owner,true),'专研');
    assert.equal(readIntelligenceLevel(config,owner,false),undefined);
    assert.equal(readIntelligenceLevel(config,{...owner,channelId:'group-b'},true),undefined);
    await saveIntelligenceLevel(config,owner,'默认');
    assert.equal(readIntelligenceLevel(config,owner,true),undefined);
    await assert.rejects(saveIntelligenceLevel(config,owner,'unlimited'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('terminal is restricted to owner private user-initiated turns',()=>{assert.equal(ownerTerminalAllowed({...identity,owner:true,private:true}),true);assert.equal(ownerTerminalAllowed({...identity,owner:true,private:true},true),false);assert.equal(ownerTerminalAllowed({...identity,owner:true}),false);assert.equal(ownerTerminalAllowed({...identity,private:true}),false);});

test('reasoning parameters only target supported official endpoints',async()=>{
 const {reasoningParameters}=await import('../lib/agent/intelligence.js');
 assert.deepEqual(reasoningParameters(new URL('https://api.deepseek.com/chat/completions'),'deepseek-v4-flash','深度'),{thinking:{type:'enabled'}});
 assert.deepEqual(reasoningParameters(new URL('https://api.deepseek.com/chat/completions'),'deepseek-v4-flash','轻快'),{thinking:{type:'disabled'}});
 assert.deepEqual(reasoningParameters(new URL('https://other.example/chat/completions'),'deepseek-v4-flash','深度'),{});
});

test('scoped persona overrides retain independent personal and group copies',async()=>{
 const {readScopedPersona,saveScopedPersona}=await import('../lib/agent/scoped-persona.js');
 const root=await mkdtemp(join(tmpdir(),'persona-scope-'));const config={workspaceRoot:join(root,'workspaces')};const owner={...identity,owner:true};
 try{
 await saveScopedPersona(config,owner,{'姓名':'小鱼'});
 assert.deepEqual(readScopedPersona(config,owner),{'姓名':'小鱼'});
 assert.deepEqual(readScopedPersona(config,{...owner,channelId:'another'}),{});
 await assert.rejects(saveScopedPersona(config,owner,{'终端权限':'允许'}));
 await saveScopedPersona(config,owner,{});assert.deepEqual(readScopedPersona(config,owner),{});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('model request sends the selected thinking switch to the actual HTTP body',async()=>{
 const {requestModelMessage}=await import('../lib/agent/tool-chat.js');const old=globalThis.fetch;let body;
 globalThis.fetch=async(_url,init)=>{body=JSON.parse(init.body);return Response.json({choices:[{message:{role:'assistant',content:'done'}}]});};
 try{
 await requestModelMessage({provider:'deepseek-official',model:'deepseek-v4-flash',maxRequestBytes:20000,budget:{enabled:false}},{apiKey:'test-key',baseUrl:'https://api.deepseek.com'},[{role:'user',content:'hello'}],[],new AbortController().signal,undefined,{intelligenceLevel:'深度'});
 assert.equal(body.thinking.type,'enabled');
 }finally{globalThis.fetch=old;}
});

test('stale persona writes cannot erase another editor changes', async()=>{
 const {readScopedPersona,saveScopedPersona}=await import('../lib/agent/scoped-persona.js');
 const root=await mkdtemp(join(tmpdir(),'persona-conflict-'));const config={workspaceRoot:join(root,'workspaces')};const owner={...identity,owner:true};
 try{
 await saveScopedPersona(config,owner,{'姓名':'甲'},{});
 await assert.rejects(saveScopedPersona(config,owner,{'背景':'乙'},{}),/已被其他操作修改/);
 assert.deepEqual(readScopedPersona(config,owner),{'姓名':'甲'});
 await saveScopedPersona(config,owner,{'姓名':'甲','背景':'乙'},{'姓名':'甲'});
 assert.equal(readScopedPersona(config,owner).背景,'乙');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('disabling bound-key elevation preserves owner control but removes subscriber privileges',()=>{
 const admin={...identity,admin:true};
 assert.equal(intelligenceAccess(admin,true,false).entitled,false);
 assert.equal(intelligenceAccess(admin,true,false).canEdit,false);
 assert.equal(intelligenceAccess(admin,true,false).defaultLevel,'标准');
 assert.equal(intelligenceAccess({...admin,owner:true},true,false).canEdit,true);
});
