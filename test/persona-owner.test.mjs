import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {personalPersonaOwnership,isPersonaOwner,isPersonaFamily,personaOwnerPrompt} from '../lib/companion/persona-owner.js';
import {ownerTerminalAllowed,intelligenceAccess} from '../lib/agent/intelligence.js';
import {PersonaStore} from '../lib/companion/personas.js';
import {resolveDSHConfig} from '../lib/dsh/config.js';
test('personal key establishes private persona relationship without granting administrative identity',()=>{
 const user={owner:false,private:true};
 assert.equal(personalPersonaOwnership(user,true),true);
 assert.equal(personalPersonaOwnership(user,false),false);
 assert.equal(personalPersonaOwnership({...user,private:false},true),false);
 assert.equal(personalPersonaOwnership({...user,owner:true,private:false},false),true);
 const context={...user,personalPersonaOwner:true};
 assert.equal(isPersonaOwner(context),true);
 assert.equal(isPersonaOwner({...context,private:false}),false);
 assert.equal(ownerTerminalAllowed(context),false);
 assert.equal(intelligenceAccess({...user,private:false,admin:false},true).canEdit,false);
 assert.match(personaOwnerPrompt(context),/独生女/);
 assert.match(personaOwnerPrompt({...user,personalPersonaOwner:false}),/网友/);
});
test('composed dafeiyu prompt reflects private relationship but retains actual owner-only rules',async()=>{
 const root=await mkdtemp(join(tmpdir(),'persona-owner-'));const store=new PersonaStore(root);
 try {
  const preset=await store.read('dafeiyu');await store.save({...preset,privateRules:'仅平台主人私聊规则',socialRules:'普通用户规则'});
  const context={platform:'qq',channelId:'a',private:true,owner:false,personalPersonaOwner:true};
  const prompt=await store.systemPrompt(resolveDSHConfig({}),context);
  assert.match(prompt,/当前发言人是本轮可信关系状态确认的人格主人/);
  assert.match(prompt,/普通用户规则/);assert.doesNotMatch(prompt,/仅平台主人私聊规则/);
  const removed=await store.systemPrompt(resolveDSHConfig({}),{...context,personalPersonaOwner:false});assert.match(removed,/当前发言人是网友/);
  const group=await store.systemPrompt(resolveDSHConfig({}),{...context,private:false});assert.match(group,/当前发言人是网友/);
  const family=await store.systemPrompt(resolveDSHConfig({}),{...context,private:false,groupPersonaFamily:true});assert.match(family,/当前发言人是本群家人/);assert.doesNotMatch(family,/仅平台主人私聊规则/);
  const otherPrivate=await store.systemPrompt(resolveDSHConfig({}),{...context,personalPersonaOwner:false,groupPersonaFamily:true});assert.match(otherPrivate,/当前发言人是网友/);
  const owner=await store.systemPrompt(resolveDSHConfig({}),{...context,owner:true,personalPersonaOwner:false});assert.match(owner,/仅平台主人私聊规则/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('group family cannot become a private owner or administrator',()=>{ const group={owner:false,private:false,groupPersonaFamily:true};assert.equal(isPersonaFamily(group),true);assert.equal(isPersonaOwner(group),false);assert.equal(isPersonaFamily({...group,private:true}),false);assert.equal(ownerTerminalAllowed(group),false);assert.equal(intelligenceAccess({...group,admin:false},true).canEdit,false); });
