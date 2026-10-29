import test from 'node:test';
import assert from 'node:assert/strict';
import { poolSnapshot, poolAction, poolBalances } from '../lib/panel/pool-service.js';
import { stopCredentialPool } from '../lib/credentials/pool.js';

test('rotation management exposes no credentials and runtime toggles do not write configuration', async () => {
  const previous = globalThis.__config;
  const value = {
    'alemonjs-agent-link': {
      modelPool: {
        probeIntervalSeconds: 0,
        endpoints: [{ id: 'first', provider: 'test', baseUrl: 'https://example.com', model: 'test-model', apiKey: 'test-private-secret' }]
      }
    }
  };
  globalThis.__config = { value };
  try {
    const snapshot = await poolSnapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.endpoints[0].id, 'first');
    assert.ok(!JSON.stringify(snapshot).includes('test-private-secret'));
    assert.equal((await poolAction('first', 'disable')).endpoints[0].disabled, true);
    assert.equal(value['alemonjs-agent-link'].modelPool.endpoints[0].enabled, undefined);
    assert.equal((await poolAction('first', 'enable')).endpoints[0].disabled, false);
    await assert.rejects(poolAction('missing', 'disable'), /端点不存在/);
    await assert.rejects(poolAction('first', 'unexpected'), /无效/);
    value['alemonjs-agent-link'].modelPool = { enabled: false };
    assert.equal((await poolSnapshot()).enabled, false);
    assert.deepEqual(await poolBalances(), {});
  } finally {
    stopCredentialPool();
    globalThis.__config = previous;
  }
});

test('one-click probing checks disabled and exhausted endpoints without enabling them', async () => {
  const { startPoolProbeRun, getPoolProbeRun } = await import('../lib/panel/pool-service.js');
  const previous = globalThis.__config;
  const originalFetch = globalThis.fetch;
  const called = [];
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        modelPool: {
          probeIntervalSeconds: 0,
          endpoints: [
            { id: 'disabled', provider: 'test', baseUrl: 'https://disabled.example', model: 'test', apiKey: 'private-key-disabled', enabled: false },
            { id: 'exhausted', provider: 'test', baseUrl: 'https://exhausted.example', model: 'test', apiKey: 'private-key-empty' }
          ]
        }
      }
    }
  };
  globalThis.fetch = async url => {
    called.push(String(url));
    return new Response('{}', { status: String(url).includes('exhausted') ? 402 : 200 });
  };
  try {
    const run = startPoolProbeRun();
    assert.equal(startPoolProbeRun(), run);
    for (let count = 0; count < 100 && getPoolProbeRun().running; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(getPoolProbeRun().running, false);
    assert.equal(called.length, 2);
    assert.ok(called.some(url => url.includes('disabled.example')));
    assert.ok(called.some(url => url.includes('exhausted.example')));
    const snapshot = await poolSnapshot();
    assert.equal(snapshot.endpoints.find(item => item.id === 'disabled').disabled, true);
    assert.equal(snapshot.endpoints.find(item => item.id === 'disabled').probeReachable, true);
    assert.equal(snapshot.endpoints.find(item => item.id === 'exhausted').probeReachable, true);
    assert.equal(snapshot.endpoints.find(item => item.id === 'exhausted').probeStatus, 402);
    const paused = await poolAction('exhausted', 'disable');
    assert.equal(paused.endpoints.find(item => item.id === 'exhausted').probeReachable, true);
    const resumed = await poolAction('exhausted', 'enable');
    assert.equal(resumed.endpoints.find(item => item.id === 'exhausted').probeStatus, 402);
    assert.equal(snapshot.endpoints.find(item => item.id === 'exhausted').lastStatus, 402);
    assert.equal(snapshot.probeRun.results.length, 2);
  } finally {
    stopCredentialPool();
    globalThis.__config = previous;
    globalThis.fetch = originalFetch;
  }
});

test('paused rotation supports diagnostics without activating business routing', async () => {
  const { startPoolProbeRun, getPoolProbeRun } = await import('../lib/panel/pool-service.js');
  const { getCredentialPool } = await import('../lib/credentials/pool.js');
  const { getDSHConfig } = await import('../lib/dsh/runtime-config.js');
  const previous = globalThis.__config;
  const originalFetch = globalThis.fetch;
  const called = [];
  const raw = {
    enabled: false,
    endpoints: [
      { id: 'paused', provider: 'deepseek-official', baseUrl: 'https://api.deepseek.com', apiKey: 'paused-private-key', model: 'test', enabled: false }
    ]
  };
  globalThis.__config = { value: { 'alemonjs-agent-link': { modelPool: raw } } };
  globalThis.fetch = async url => {
    called.push(String(url));
    return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12' }] }), { status: 200 });
  };
  try {
    const run = startPoolProbeRun();
    for (let count = 0; count < 100 && run.running; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(getPoolProbeRun().running, false);
    const snapshot = await poolSnapshot();
    assert.equal(snapshot.enabled, false);
    assert.equal(snapshot.endpoints[0].disabled, true);
    assert.equal(snapshot.endpoints[0].probeReachable, true);
    assert.equal((await poolBalances('paused')).paused.amount, 12);
    assert.equal((await poolAction('paused', 'probe')).enabled, false);
    assert.equal(getCredentialPool(getDSHConfig()), null);
    assert.equal(raw.enabled, false);
    assert.equal(raw.endpoints[0].enabled, false);
    assert.ok(called.some(url => url.includes('/user/balance')));
    await assert.rejects(poolBalances('missing'), /端点不存在/);
  } finally {
    stopCredentialPool();
    globalThis.__config = previous;
    globalThis.fetch = originalFetch;
  }
});

test('explicit health check calls chat for disabled keys, refreshes result, and keeps enablement', async () => {
  const previous=globalThis.__config;
  const originalFetch=globalThis.fetch;
  const raw={enabled:false,probeChat:false,probeIntervalSeconds:0,endpoints:[{id:'health-test',provider:'test',baseUrl:'https://health.example/v1',apiKey:'health-private-secret',model:'test-model',enabled:false}]};
  globalThis.__config={value:{'alemonjs-agent-link':{modelPool:raw}}};
  let requests=0;
  globalThis.fetch=async (url,options)=>{
    requests++;
    assert.equal(String(url),'https://health.example/v1/chat/completions');
    assert.equal(JSON.parse(options.body).model,'test-model');
    assert.equal(JSON.parse(options.body).stream,false);
    if(requests===1)return Response.json({error:{code:'account_frozen',message:'frozen'}},{status:403});
    if(requests===2)return Response.json({choices:[{message:{role:'assistant',content:'OK'}}]});
    return Response.json({unexpected:true});
  };
  try{
    const failed=await poolAction('health-test','health-check');
    assert.equal(failed.endpoints[0].lastRequest.reason,'frozen');
    assert.equal(failed.endpoints[0].lastRequest.source,'health-check');
    assert.equal(failed.endpoints[0].disabled,true);
    const healthy=await poolAction('health-test','health-check');
    assert.equal(healthy.endpoints[0].lastRequest.reason,'success');
    assert.equal(healthy.endpoints[0].disabled,true);
    assert.equal(healthy.enabled,false);
    assert.equal(raw.enabled,false);
    assert.equal(raw.endpoints[0].enabled,false);
    assert.equal(healthy.endpoints[0].totalCalls,0);
    assert.ok(!JSON.stringify(healthy).includes('health-private-secret'));
    const malformed=await poolAction('health-test','health-check');
    assert.equal(malformed.endpoints[0].lastRequest.ok,false);
    await assert.rejects(poolAction('missing','health-check'),/端点不存在/);
  } finally {globalThis.__config=previous;globalThis.fetch=originalFetch;stopCredentialPool();}
});

test('pool page snapshots refresh balances automatically and reuse cached results',async()=>{
 const previous=globalThis.__config;
 const previousFetch=globalThis.fetch;
 globalThis.__config={value:{'alemonjs-agent-link':{modelPool:{probeIntervalSeconds:0,endpoints:[{id:'auto-balance',provider:'deepseek-official',baseUrl:'https://api.deepseek.com',model:'test',apiKey:'auto-private-secret'}]}}}};
 let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({is_available:true,balance_infos:[{currency:'CNY',total_balance:'42'}]});};
 try {
   await poolSnapshot();
   let latest;
   for(let i=0;i<20;i++){await new Promise(resolve=>setTimeout(resolve,5));latest=await poolSnapshot();if(latest.balances['auto-balance'])break;}
   assert.equal(latest.balances['auto-balance'].amount,42);
   assert.equal(calls,1);
   await poolSnapshot();
   assert.equal(calls,1);
 }finally{globalThis.__config=previous;globalThis.fetch=previousFetch;stopCredentialPool();}
});
