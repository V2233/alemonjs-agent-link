import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {AppearanceStore} from '../lib/media/appearance-store.js';
import {editAppearanceImage} from '../lib/media/image-generation.js';
const png=await sharp({create:{width:16,height:16,channels:3,background:'#4488cc'}}).png().toBuffer();
test('appearance originals and derivatives remain isolated and survive reopen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'appearances-')),path=join(root,'appearances.sqlite');let store=new AppearanceStore(path);
 try {
  const base=await store.add('dafeiyu','默认',png);assert.equal(base.primary,true);
  const child=await store.add('dafeiyu','冬装',png,base.id);assert.equal(child.primary,false);assert.equal(child.parentId,base.id);
  assert.throws(()=>store.read(base.id,'assistant'),/不属于/);await assert.rejects(store.add('assistant','跨人设引用',png,base.id),/不属于/);
  await assert.rejects(store.add('dafeiyu','损坏图',Buffer.from('bad')));
  assert.throws(()=>store.edit(base.id,'delete'),/二创/);
  store.edit(child.id,'primary');assert.equal(store.list('dafeiyu')[0].id,child.id);
  store.close();store=new AppearanceStore(path);assert.equal(store.list('dafeiyu')[0].id,child.id);
  assert.equal((await sharp(store.read(base.id).data).metadata()).format,'png');
  store.edit(child.id,'delete');assert.equal(store.list('dafeiyu')[0].primary,true);store.edit(base.id,'delete');assert.equal(store.list().length,0);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('editing submits actual reference bytes and never retries text generation on error',async()=>{
 const beforeFetch=globalThis.fetch,beforeConfig=globalThis.__config;let calls=0;
 globalThis.__config={value:{'alemonjs-agent-link':{budget:{enabled:false}}}};
 const config={imageGen:{baseUrl:'https://images.example/v1',apiKey:'test',model:'image-edit',size:'1024x1024',stylePrompt:'',ownerOnly:false},maxBytes:5*1024*1024,timeoutMs:10000,allowedHosts:[]};
 try {
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://images.example/v1/images/edits');assert.ok(init.body instanceof FormData);assert.deepEqual(Buffer.from(await init.body.get('image').arrayBuffer()),png);assert.match(init.body.get('prompt'),/换成冬装/);assert.equal(init.headers['Content-Type'],undefined);return Response.json({data:[{b64_json:png.toString('base64')}]});};
  assert.deepEqual(await editAppearanceImage('换成冬装',png,config,new AbortController().signal),png);assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;return new Response('unsupported',{status:400});};
  await assert.rejects(editAppearanceImage('换成冬装',png,config,new AbortController().signal));assert.equal(calls,2);
  await assert.rejects(editAppearanceImage('冬装',png,{...config,imageGen:{...config.imageGen,protocol:'siliconflow'}},new AbortController().signal),/编辑接口/);assert.equal(calls,2);
 }finally{globalThis.fetch=beforeFetch;globalThis.__config=beforeConfig;}
});
