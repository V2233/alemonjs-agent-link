import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {beginTokenUsage,readTokenUsage,usageDay,tokenKeyId,tokenUsageFetch} from '../lib/billing/token-usage.js';
test('usage survives key removal, aggregates day/month/year/all and deduplicates settlement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'token-ledger-'));
 try{
 const id=tokenKeyId(new URL('https://example.com/v1'),'secret');const at=Date.parse('2026-12-31T16:00:00Z');
 assert.equal(usageDay(at),'2027-01-01');
 const settle=beginTokenUsage(root,id,at);settle({prompt_tokens:10,completion_tokens:4,prompt_cache_hit_tokens:3});settle({prompt_tokens:10,completion_tokens:4});
 beginTokenUsage(root,'removed-key',at)({prompt_tokens:20,completion_tokens:6});beginTokenUsage(root,'unknown',at)({});
 for(const period of ['2027-01-01','2027-01','2027','all']){const data=readTokenUsage(root,period);assert.equal(data.total.input,30);assert.equal(data.total.output,10);assert.equal(data.total.cached,3);assert.equal(data.total.requests,3);assert.equal(data.total.known,2);assert.equal(data.keys.length,3);}
 assert.equal(readTokenUsage(root,'2026').total.input,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('JSON and SSE record actual credentials even without budget enforcement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'token-http-'));const old=globalThis.fetch;
 try{
 for(const streaming of [false,true]){
 globalThis.fetch=async(_url,init)=>{if(streaming)assert.equal(JSON.parse(init.body).stream_options.include_usage,true);return new Response(streaming?'data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n':JSON.stringify({usage:{prompt_tokens:5,completion_tokens:2}}),{headers:{'content-type':streaming?'text/event-stream':'application/json'}});};
 const response=await tokenUsageFetch({dshHomeRoot:join(root,'homes')},new URL('https://example.com/chat/completions'),{headers:{Authorization:'Bearer private-secret'},body:JSON.stringify({stream:streaming})});await response.text();
 }
 assert.equal(readTokenUsage(root,'all').total.input,10);assert.equal(readTokenUsage(root,'all').keys.length,1);
 }finally{globalThis.fetch=old;await rm(root,{recursive:true,force:true});}
});
test('Python workspace and Node HTTP write the same independent totals',async()=>{
 const root=await mkdtemp(join(tmpdir(),'token-python-'));
 try{
 const id=tokenKeyId(new URL('https://example.com'),'same-secret');beginTokenUsage(root,id)({prompt_tokens:3,completion_tokens:2});
 execFileSync('python3',['-c',"import sys;from pathlib import Path;sys.path.insert(0,'python');from token_usage import begin_usage,extract_tokens;f=begin_usage(Path(sys.argv[1]),'https://example.com/v1/messages','same-secret');u=extract_tokens(b'data: {\"message\":{\"usage\":{\"input_tokens\":7,\"cache_read_input_tokens\":2}}}\\n\\ndata: {\"usage\":{\"output_tokens\":4}}\\n');f(u);f(u)",root]);
 const data=readTokenUsage(root,'all');assert.equal(data.total.input,12);assert.equal(data.total.output,6);assert.equal(data.total.requests,2);assert.equal(data.keys.length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
