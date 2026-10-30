import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PersonaStore} from '../lib/companion/personas.js';
import {resolveDSHConfig} from '../lib/dsh/config.js';
import {personaDetailFields} from '../lib/companion/persona-details.js';
test('three complete presets load in empty installs, select through config and preserve local overrides',async()=>{
 const root=await mkdtemp(join(tmpdir(),'persona-presets-'));const store=new PersonaStore(root);
 try {
  const expected={assistant:'阿柠檬',dafeiyu:'大肥鱼',xunqing:'百里寻晴'};
  assert.deepEqual((await store.list()).map(row=>[row.id,row.name,row.builtin]),Object.entries(expected).sort().map(([id,name])=>[id,name,true]));
  for(const [id,name] of Object.entries(expected)){
   const preset=await store.read(id);assert.equal(preset.name,name);assert.deepEqual(Object.keys(preset.details).sort(),[...personaDetailFields].sort());
   const config=resolveDSHConfig({persona:id});
   assert.equal(config.defaultSystemPrompt,preset.prompt);
   const prompt=await store.systemPrompt(config,{platform:'qq',channelId:'g',private:false,owner:false});assert.ok(prompt.startsWith(preset.prompt));assert.ok(prompt.includes('【语言指纹】'));
   const custom=resolveDSHConfig({persona:id,defaultSystemPrompt:'自定义基础'});assert.equal(custom.defaultSystemPrompt,'自定义基础');
   await store.save({...preset,name:'本地名称',prompt:'本地正文'});assert.equal((await store.read(id)).prompt,'本地正文');
   assert.equal((await store.list()).find(row=>row.id===id).builtin,true);
   await store.remove(id);assert.equal((await store.read(id)).name,name);
  }
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
