import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import sharp from 'sharp';
import {getMediaConfig} from '../lib/media/config.js';
import {imageGenerationTool} from '../lib/media/image-generation.js';

test('real sandboxed DSH plugin receives a failed primary request and returns an attachment to the reply queue', {skip: !process.env.AGENT_LINK_TEST_DSH_IMAGEGEN}, async () => {
  const previous=globalThis.__config, oldFetch=globalThis.fetch;
  const png=await sharp({create:{width:64,height:64,channels:3,background:'#0088ff'}}).png().toBuffer();
  let requests=0, deliveries=0, primary=0;
  const server=createServer(async (req,res)=>{
    requests++;
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    assert.equal(req.url,'/v1/images/generations');
    assert.equal(body.model,'fixture-image');
    assert.match(body.prompt,/蓝色/);
    assert.equal(req.headers.authorization,'Bearer fixture-key');
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  globalThis.__config={value:{'alemonjs-agent-link':{
    budget:{enabled:false},stateBackend:'local',
    pythonExecutable:join(process.cwd(),'.data/agent-link/venv/bin/python'),
    dshHomeRoot:join(process.cwd(),'.data/agent-link/dsh-homes')
  }}};
  const media=getMediaConfig({media:{dshImageFallback:true,timeoutMs:60000,imageGen:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-image',apiKey:'fixture-key',size:'1024x1024'}}});
  globalThis.fetch=async()=>{primary++;return new Response('',{status:503});};
  try {
    const result=await imageGenerationTool(media,async data=>{deliveries++;assert.equal((await sharp(data).metadata()).width,64);}).execute({prompt:'蓝色圆形'},{signal:AbortSignal.timeout(90000)});
    assert.equal(result.source,'dsh-image-gen');assert.equal(result.delivery,'queued-for-this-reply');
    assert.equal(primary,1);assert.equal(requests,1);assert.equal(deliveries,1);
  } finally {globalThis.__config=previous;globalThis.fetch=oldFetch;await new Promise(resolve=>server.close(resolve));}
});
