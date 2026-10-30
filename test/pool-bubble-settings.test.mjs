import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parse} from 'yaml';
import {createTestApp} from 'alemonjs/testing';
import {getConfig} from 'alemonjs';
import {initializeAdminPanel,disposeAdminPanel} from '../lib/panel/admin-panel.js';
import {getCredentialPool} from '../lib/credentials/pool.js';
import {poolSnapshot} from '../lib/panel/pool-service.js';
import handler from '../lib/response/agent-pool/res.js';

test('pool mutations, balance and failed probes preserve page and truthful status',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pool-bubble-settings-'));
  const path=join(root,'config.yaml');
  const settings={stateBackend:'local',workspaceRoot:join(root,'work'),dshHomeRoot:join(root,'home'),modelPool:{probeIntervalSeconds:0,endpoints:Array.from({length:7},(_,i)=>({id:`endpoint-${i}`,provider:'fixture',model:'fixture',baseUrl:'https://fixture.invalid/v1',apiKey:`fixture-secret-${i}`,balanceUrl:'https://fixture.invalid/balance?key={key}'}))}};
  const initial={other:{retained:true},'alemonjs-agent-link':settings};
  await writeFile(path,JSON.stringify(initial));
  const previous=globalThis.__config;
  const oldFetch=globalThis.fetch;
  globalThis.__config={path,value:initial,reload(){throw new Error('fixture-reload-failure');}};
  let app;
  try {
    await initializeAdminPanel();
    app=createTestApp({config:initial});
    const run=async(args)=>{
      const event=app.events.privateMessage({}, {Platform:'qq-bot',UserId:'u',IsMaster:true,MessageText:`/额度轮转 ${args.join(' ')}`,__route:{key:'额度轮转',text:'额度轮转',rawArgs:args,parsedArgs:[],params:{}}});
      const result=await app.runHandler(async()=>{
        const config=getConfig(),reload=config.reload;
        config.reload=()=>{throw new Error('fixture-reload-failure');};
        try {await handler();} finally {config.reload=reload;}
      },event,'alemonjs-agent-link');
      assert.equal(result.errors.length,0);
      const wire=JSON.stringify(result.actions.map(a=>a.request.payload?.params));
      assert.doesNotMatch(wire,/fixture-secret|fixture-reload-failure|BT.group/);
      return {text:JSON.stringify(result.messages),wire};
    };
    const off=await run(['停用','endpoint-6']);
    assert.match(off.wire,/\/额度轮转 2/);
    assert.match(off.text,/设置已保存/);
    assert.match(off.text,/运行状态尚未刷新/);
    let saved=parse(await readFile(path,'utf8'));
    assert.equal(saved['alemonjs-agent-link'].modelPool.endpoints[6].enabled,false);
    assert.equal(saved['alemonjs-agent-link'].modelPool.endpoints[6].apiKey,'fixture-secret-6');
    assert.equal(saved.other.retained,true);
    const on=await run(['启用','endpoint-6']);
    assert.match(on.wire,/\/额度轮转 2/);
    saved=parse(await readFile(path,'utf8'));
    assert.equal(saved['alemonjs-agent-link'].modelPool.endpoints[6].enabled,true);
    const before=await readFile(path,'utf8');
    assert.match((await run(['停用','missing'])).text,/端点已不存在/);
    assert.equal(await readFile(path,'utf8'),before);
    let balanceFailure=false;
    const destinations=[];
    globalThis.fetch=async url=>{
      const address=String(url);destinations.push(address);
      assert.ok(address.startsWith('https://fixture.invalid/'));
      if(new URL(address).pathname.endsWith('/balance'))return balanceFailure?new Response('fixture-secret-upstream',{status:403}):Response.json({balance:1.25,currency:'CNY'});
      return new Response('fixture-secret-upstream',{status:401});
    };
    const balance=await run(['查额度','endpoint-6']);
    assert.match(balance.text,/1.25/);
    assert.match(balance.wire,/\/额度轮转 2/);
    balanceFailure=true;
    const failedBalance=await run(['查额度','endpoint-6']);
    assert.doesNotMatch(failedBalance.text,/1.25|fixture-secret/);
    assert.match(failedBalance.wire,/\/额度轮转 2/);
    const probe=await run(['测活','endpoint-6']);
    assert.match(probe.text,/不代表检测通过/);
    assert.match(probe.wire,/\/额度轮转 2/);
    const health=await run(['通测','endpoint-6']);
    assert.match(health.text,/不代表检测通过/);
    assert.match(health.wire,/\/额度轮转 2/);
    let snapshot;
    const event=app.events.privateMessage({}, {Platform:'qq-bot',IsMaster:true});
    await app.invoke(event,async()=>{snapshot=await poolSnapshot();},'alemonjs-agent-link');
    assert.equal(snapshot.endpoints.find(row=>row.id==='endpoint-6').healthy,false);
    assert.ok(destinations.some(url=>url.endsWith('/models')));
    assert.ok(destinations.some(url=>url.endsWith('/chat/completions')));
    const refreshed=await run(['2']);
    assert.match(refreshed.text,/第 2\/2 页/);
    assert.doesNotMatch(refreshed.wire,/fixture-secret/);

  } finally {getCredentialPool({});globalThis.fetch=oldFetch;await app?.dispose();disposeAdminPanel();globalThis.__config=previous;await rm(root,{recursive:true,force:true});}
});
