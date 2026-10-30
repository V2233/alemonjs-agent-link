import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialPool } from '../lib/credentials/pool.js';
import { parseModelPool } from '../lib/model-pool/config.js';

test('call statistics count outcomes once, exclude inspection, and survive reload across days', async () => {
  const directory = await mkdtemp(join(tmpdir(),'pool-statistics-'));
  const path = join(directory,'metrics.json');
  const config = parseModelPool({probeIntervalSeconds:0,endpoints:[{id:'one',apiKey:'test-key-one',model:'test'}]}, {provider:'test',baseUrl:'https://example.com',model:'test'});
  let now = Date.now();
  const pool = new CredentialPool(config,()=>now,path);
  const originalFetch=globalThis.fetch;
  let reloaded;
  try {
    const first=pool.select();
    first.report({ok:true,status:200});
    first.report({ok:false,status:500});
    const second=pool.select();
    second.report({ok:false,status:400,detail:'account frozen, private user text'});
    pool.select({reserve:false}).report({ok:true});
    globalThis.fetch=async()=>new Response('{}',{status:200});
    await pool.probeEndpoint('one',false);
    const row=pool.status[0];
    assert.equal(row.totalCalls,2);
    assert.equal(row.successfulCalls,1);
    assert.equal(row.failedCalls,1);
    assert.equal(row.failures,0);
    assert.equal(row.lastRequest.reason,'frozen');
    assert.equal(row.lastRequest.status,400);
    assert.ok(!JSON.stringify(row.lastRequest).includes('private user text'));
    let stored;
    for(let i=0;i<100;i++){
      stored=await readFile(path,'utf8').then(JSON.parse).catch(()=>null);
      if(stored?.one?.failedCalls===1)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(stored.one.totalCalls,2);
    now+=86400000;
    reloaded=new CredentialPool(config,()=>now,path);
    assert.equal(reloaded.status[0].totalCalls,2);
    assert.equal(reloaded.status[0].successfulCalls,1);
    assert.equal(reloaded.status[0].failedCalls,1);
    assert.equal(reloaded.status[0].dailyRequests,0);
    assert.equal(reloaded.status[0].lastRequest.reason,'frozen');
    assert.equal(reloaded.status[0].statisticsSince,row.statisticsSince);
  } finally {
    pool.stop();reloaded?.stop();globalThis.fetch=originalFetch;
    await new Promise(resolve=>setTimeout(resolve,30));
    await rm(directory,{recursive:true,force:true});
  }
});

test('latest request categories distinguish billing, permissions, and API failures', async()=>{
  const { requestReason } = await import('../lib/model-pool/request-result.js');
  for(const [outcome,expected] of [
    [{ok:true,status:200},'success'],
    [{ok:false,status:403},'forbidden'],
    [{ok:false,status:403,detail:'account_frozen'},'frozen'],
    [{ok:false,status:400,detail:'insufficient_quota'},'exhausted'],
    [{ok:false,status:402},'exhausted'],
    [{ok:false,status:429},'rate-limited'],
    [{ok:false,status:429,detail:'quota_exceeded'},'exhausted'],
    [{ok:false,errorKind:'pricing-unconfigured'},'pricing-unconfigured'],
    [{ok:false,status:401},'invalid'],
    [{ok:false,status:503},'server-error'],
    [{ok:false},'network'],
    [{ok:false,errorKind:'local-budget'},'local-budget'],
    [{ok:false,errorKind:'cancelled'},'cancelled'],
    [{ok:false,errorKind:'timeout'},'timeout']
  ]) assert.equal(requestReason(outcome),expected);
});

test('lifecycle distinguishes reserved, dispatched, blocked and completed attempts',async()=>{
 const config=parseModelPool({probeIntervalSeconds:0,endpoints:[{id:'lifecycle',apiKey:'test-life-key',model:'test'}]},{provider:'test',baseUrl:'https://example.com',model:'test'});
 const pool=new CredentialPool(config);
 try{
   const blocked=pool.select();
   blocked.report({ok:false,errorKind:'local-budget'});
   const sent=pool.select();
   sent.markSent();sent.markSent();
   sent.report({ok:true,status:200});sent.report({ok:false,status:500});
   const row=pool.status[0];
   assert.equal(row.totalCalls,2);
   assert.equal(row.lifecycle.sent,1);
   assert.equal(row.lifecycle.blocked,1);
   assert.equal(row.lifecycle.records.length,2);
   assert.equal(row.lifecycle.records[0].sent,false);
   assert.equal(row.lifecycle.records[1].sent,true);
   assert.equal(row.lifecycle.records[1].ok,true);
   assert.notEqual(row.lifecycle.records[0].id,row.lifecycle.records[1].id);
 }finally{pool.stop();}
});

test('HTTP 200 with invalid model content is a failure rather than a success',async()=>{
 const {requestModelMessage}=await import('../lib/agent/tool-chat.js');
 const config=parseModelPool({probeIntervalSeconds:0,maxAttempts:1,endpoints:[{id:'invalid-body',apiKey:'test-life-key',model:'test'}]},{provider:'test',baseUrl:'https://example.com',model:'test'});
 const pool=new CredentialPool(config);
 const previous=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({data:[]});
 try{
   await assert.rejects(requestModelMessage({provider:'test',model:'test',maxRequestBytes:10000,budget:{enabled:false}},pool.select(),[{role:'user',content:'hi'}],[],new AbortController().signal));
   assert.equal(pool.status[0].successfulCalls,0);
   assert.equal(pool.status[0].failedCalls,1);
   assert.equal(pool.status[0].lifecycle.sent,1);
   assert.equal(pool.status[0].lastRequest.reason,'invalid-response');
 }finally{globalThis.fetch=previous;pool.stop();}
});

test('stop flushes before reload, removed IDs survive, and diagnostics cannot overwrite metrics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pool-retention-'));
  const path = join(directory, 'nested', 'metrics.json');
  const make = ids => parseModelPool({probeIntervalSeconds: 0, endpoints: ids.map(id => ({id, apiKey:'test-key', model:'test'}))}, {provider:'test', baseUrl:'https://example.com', model:'test'});
  try {
    const first = new CredentialPool(make(['one']), Date.now, path);
    first.select().report({ok:true});
    first.stop();
    const diagnostic = new CredentialPool(make(['one']), Date.now, path, true);
    assert.equal(diagnostic.status[0].totalCalls, 1);
    const second = new CredentialPool(make(['two']), Date.now, path);
    second.select().report({ok:true});
    second.stop();
    diagnostic.stop();
    const restored = new CredentialPool(make(['one', 'two']), Date.now, path);
    assert.deepEqual(restored.status.map(row => row.totalCalls), [1,1]);
    restored.stop();
  } finally { await rm(directory, {recursive:true, force:true}); }
});

test('cache observations separate unknown usage from zero hits and persist by purpose', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pool-cache-'));
  const path = join(directory, 'metrics.json');
  const config = parseModelPool({probeIntervalSeconds:0,endpoints:[{id:'cache',apiKey:'test-key',model:'test'}]}, {provider:'test',baseUrl:'https://example.com',model:'test'});
  const pool = new CredentialPool(config, Date.now, path);
  let restored;
  try {
    const credential = pool.select({purpose:'tools'});
    credential.reportUsage({prompt_tokens:100,prompt_cache_hit_tokens:80});
    credential.reportUsage({prompt_tokens:50,prompt_tokens_details:{cached_tokens:0}});
    credential.reportUsage({prompt_tokens:60});
    credential.reportUsage({prompt_tokens:10,prompt_cache_hit_tokens:11});
    assert.deepEqual(pool.status[0].cacheStatistics.tools, {reports:4,known:2,input:150,hit:80});
    credential.report({ok:true});
    for(let i=0;i<100;i++) {
      const stored = await readFile(path,'utf8').then(JSON.parse).catch(()=>null);
      if(stored?.cache?.cacheStatistics?.tools?.reports===4) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    restored = new CredentialPool(config, Date.now, path);
    assert.deepEqual(restored.status[0].cacheStatistics.tools, {reports:4,known:2,input:150,hit:80});
  } finally {
    pool.stop(); restored?.stop();
    await new Promise(resolve=>setTimeout(resolve,30));
    await rm(directory,{recursive:true,force:true});
  }
});

test('local pricing errors are distinct from network errors', async () => {
 const { DSHError, localRequestFailure } = await import('../lib/dsh/errors.js');
 assert.equal(localRequestFailure(new DSHError('budget', '当前服务商尚未配置可核验的价格，已暂停付费调用。')), 'pricing-unconfigured');
 assert.equal(localRequestFailure(new DSHError('budget', '额度不足')), 'local-budget');
 assert.equal(localRequestFailure(new DSHError('disabled', '关闭')), 'local-disabled');
 assert.equal(localRequestFailure(new TypeError('fetch failed')), undefined);
});
