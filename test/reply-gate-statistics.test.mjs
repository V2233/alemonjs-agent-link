import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyGroupReply} from '../lib/social/reply-gate.js';
import {readReplyGateStatistics} from '../lib/social/reply-gate-statistics.js';
import {getDSHConfig} from '../lib/dsh/runtime-config.js';

test('independent gate credentials count every attempt including HTTP and transport failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gate-all-statistics-'));
 const previous=globalThis.__config;
 const originalFetch=globalThis.fetch;
 globalThis.__config={value:{'alemonjs-agent-link':{workspaceRoot:join(dir,'work'),apiKey:'main-test-key',replyGate:{apiKey:'independent-test-key',baseUrl:'https://gate.example',model:'test-gate'}}}};
 let count=0;
 globalThis.fetch=async()=>{
  count++;
  if(count===2)return Response.json({error:{message:'frozen'}},{status:403});
  if(count===3)throw new Error('network failed');
  return Response.json({choices:[{message:{content:JSON.stringify({addressed:'none',related:'none',source:'human',loopRisk:false})}}]});
 };
 try{
  const input={recent:[],messages:[]};
  for(let i=0;i<3;i++)await classifyGroupReply(input,new AbortController().signal);
  const result=readReplyGateStatistics(getDSHConfig());
  assert.equal(result.total,3);
  assert.equal(result.success,1);
  assert.equal(result.failed,2);
  const stored=JSON.parse(await readFile(join(dir,'reply-gate-statistics.json'),'utf8'));
  assert.equal(stored.total,3);
  assert.ok(!JSON.stringify(stored).includes('independent-test-key'));
 }finally{globalThis.__config=previous;globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
});
