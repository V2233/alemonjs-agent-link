import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from 'alemonjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readIntelligenceLevel } from '../lib/agent/intelligence.js';
import handler from '../lib/response/agent-intelligence/res.js';

test('permissions query cannot change intelligence; settings command still can', async () => {
  const root = await mkdtemp(join(tmpdir(), 'command-rights-'));
  const config = { workspaceRoot: join(root, 'workspaces'), stateBackend: 'local' };
  const app = createTestApp({ config: { 'alemonjs-agent-link': config } });
  const identity = { platform: 'qq-bot', channelId: 'private:["qq-bot","100"]', userId: '100', owner: true, private: true };
  const run = (key, args) =>
    app.runHandler(
      handler,
      app.events.privateMessage(
        {},
        {
          Platform: 'qq-bot',
          UserId: '100',
          IsMaster: true,
          MessageText: `/${key} ${args.join(' ')}`,
          __route: { key, text: key, rawArgs: args, parsedArgs: [], params: {} }
        }
      ),
      'alemonjs-agent-link'
    );
  try {
    await run('智能程度', ['轻快']);
    assert.equal(readIntelligenceLevel(config, identity, true), '轻快');
    await run('我的权限', ['专研']);
    assert.equal(readIntelligenceLevel(config, identity, true), '轻快');
    await run('智能程度', ['专研']);
    assert.equal(readIntelligenceLevel(config, identity, true), '专研');
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy persona entries deny group administrators without key entitlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-rights-'));
  const config = { workspaceRoot: join(root, 'workspaces'), dshHomeRoot: join(root, 'homes'), stateBackend: 'local' };
  const app = createTestApp({ config: { 'alemonjs-agent-link': config } });
  const { getPersonaStore } = await import('../lib/companion/personas.js');
  const { getDSHConfig } = await import('../lib/dsh/runtime-config.js');
  try {
    for (const [name, key, args] of [
      ['agent-persona', '人格', ['使用', 'assistant']],
      ['agent-group-settings', '群设置', ['人设', '测试内容']]
    ]) {
      const handler = (await import(`../lib/response/${name}/res.js`)).default;
      const event = app.events.groupMessage(
        {},
        {
          Platform: 'qq-bot',
          ChannelId: 'g1',
          UserId: '100',
          IsMaster: false,
          IsAdmin: true,
          Role: 'admin',
          MessageText: `/${key} ${args.join(' ')}`,
          __route: { key, text: key, rawArgs: args, parsedArgs: [], params: {} }
        }
      );
      const result = await app.runHandler(handler, event, 'alemonjs-agent-link');
      assert.equal(result.errors.length, 0);
      assert.match(JSON.stringify(result.messages), /Key/);
      await app.invoke(
        event,
        () => {
          const store = getPersonaStore(getDSHConfig());
          const scope = { platform: 'qq-bot', channelId: 'g1' };
          assert.ok(!store.selected(scope));
          assert.ok(!store.scopeAdditions(scope));
        },
        'alemonjs-agent-link'
      );
    }
  } finally {
    await app.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('persona field browser paginates and exposes editing only to an entitled editor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-browser-'));
  const config = {workspaceRoot:join(root,'workspaces'),dshHomeRoot:join(root,'homes'),stateBackend:'local'};
  const app = createTestApp({config:{'alemonjs-agent-link':config}});
  const handler = (await import('../lib/response/agent-scoped-persona/res.js')).default;
  const run = async (master, args) => app.runHandler(handler, app.events.privateMessage({}, {
    Platform:'qq-bot',UserId:'100',IsMaster:master,MessageText:`/人设 ${args.join(' ')}`,
    __route:{key:'人设',text:'人设',rawArgs:args,parsedArgs:[],params:{}}
  }), 'alemonjs-agent-link');
  try {
    const first = await run(true,[]);
    assert.equal(first.errors.length,0);
    assert.match(JSON.stringify(first.messages),/下一页/);
    assert.match(JSON.stringify(first.actions),/人设 编辑/);
    const second = await run(true,['2']);
    assert.match(JSON.stringify(second.messages),/上一页/);
    const ordinary = await run(false,[]);
    assert.doesNotMatch(JSON.stringify(ordinary.actions),/人设 编辑|人设 清空/);
    assert.match(JSON.stringify(ordinary.messages),/权益未启用/);
  } finally { await app.dispose();await rm(root,{recursive:true,force:true}); }
});

test('group settings menus expose only usable actions to members and administrators', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-menu-'));
  const app = createTestApp({config:{'alemonjs-agent-link':{workspaceRoot:join(root,'workspaces'),dshHomeRoot:join(root,'homes'),stateBackend:'local'}}});
  const handler = (await import('../lib/response/agent-group-settings/res.js')).default;
  const run = async (admin, args) => {
    const result = await app.runHandler(handler, app.events.groupMessage({}, {
      Platform:'qq-bot',ChannelId:'g',UserId:'u',IsMaster:false,IsAdmin:admin,Role:admin?'admin':'member',
      MessageText:`/群设置 ${args.join(' ')}`,__route:{key:'群设置',text:'群设置',rawArgs:args,parsedArgs:[],params:{}}
    }), 'alemonjs-agent-link');
    assert.equal(result.errors.length,0);
    return JSON.stringify(result.actions);
  };
  try {
    for(const args of [['帮助'],['语音','查看'],['唤醒词','查看']]) {
      const member = await run(false,args);
      assert.doesNotMatch(member,/qqbot-cmd-input text=\\"\/群设置 (?:安静|静默|重置|语音 关闭|语音 自动关闭|人设 清空|唤醒词 清空)/);
      // Inspect structured action data as well, independent of platform serialization.
      assert.doesNotMatch(member,/"data":"\/群设置 (?:安静|静默|重置|语音 关闭|语音 自动关闭|人设 清空|唤醒词 清空)/);
      assert.match(member,/返回设置/);
    }
    const admin = await run(true,['语音','查看']);
    assert.match(admin,/关闭语音/);
    assert.match(admin,/自动关闭/);
    assert.doesNotMatch(await run(true,['帮助']),/"data":"\/群设置 人设 清空/);
  } finally {await app.dispose();await rm(root,{recursive:true,force:true});}
});

test('persona edit journey preserves the field page and rejects accidental clearing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-journey-'));
  const config = {workspaceRoot:join(root,'workspaces'),dshHomeRoot:join(root,'homes'),stateBackend:'local'};
  const app = createTestApp({config:{'alemonjs-agent-link':config}});
  const handler = (await import('../lib/response/agent-scoped-persona/res.js')).default;
  const {readScopedPersona} = await import('../lib/agent/scoped-persona.js');
  const identity={platform:'qq-bot',channelId:'private:["qq-bot","100"]',userId:'100',owner:true,private:true};
  const run = async (args,master=true) => {
    const result=await app.runHandler(handler,app.events.privateMessage({}, {
      Platform:'qq-bot',UserId:'100',IsMaster:master,MessageText:`/人设 ${args.join(' ')}`,
      __route:{key:'人设',text:'人设',rawArgs:args,parsedArgs:[],params:{}}
    }),'alemonjs-agent-link');
    assert.equal(result.errors.length,0);
    return result;
  };
  try {
    const draft=await run(['编辑','工作简历']);
    assert.match(JSON.stringify(draft.messages),/新内容/);
    assert.match(JSON.stringify(draft.messages),/返回第2页/);
    assert.deepEqual(readScopedPersona(config,identity),{});
    await run(['编辑','工作简历','会写代码']);
    assert.equal(readScopedPersona(config,identity).工作简历,'会写代码');
    const detail=await run(['查看','工作简历']);
    assert.match(JSON.stringify(detail.messages),/返回第2页/);
    await run(['清空','工作简历','多余参数']);
    assert.equal(readScopedPersona(config,identity).工作简历,'会写代码');
    const blocked=await run(['恢复默认'],false);
    assert.doesNotMatch(JSON.stringify(blocked.messages),/确认清除细节/);
    const preview=await run(['恢复默认']);
    assert.match(JSON.stringify(preview.messages),/1 项/);
    assert.equal(readScopedPersona(config,identity).工作简历,'会写代码');
    await run(['恢复默认','确认']);
    assert.deepEqual(readScopedPersona(config,identity),{});
  } finally {await app.dispose();await rm(root,{recursive:true,force:true});}
});

test('grant list preserves page context and clamps the page after deleting its last record', {skip: !process.env.AGENT_LINK_TEST_REDIS_CONFIG}, async () => {
  const root=await mkdtemp(join(tmpdir(),'grant-journey-'));
  const {readFile} = await import('node:fs/promises');
  const {default:YAML} = await import('yaml');
  const connection = YAML.parse(await readFile(process.env.AGENT_LINK_TEST_REDIS_CONFIG,'utf8')).db.redis;
  const {default:Redis} = await import('ioredis');
  const previousRedis=globalThis.ioRedis;
  const redis=new Redis({...connection,maxRetriesPerRequest:0,retryStrategy:()=>null});
  redis.on('error',()=>{});
  await redis.ping();
  globalThis.ioRedis=redis;
  const {randomUUID} = await import('node:crypto');
  const platform = 'test-'+randomUUID();
  const app=createTestApp({config:{db:{redis:connection},'alemonjs-agent-link':{workspaceRoot:join(root,'workspaces'),dshHomeRoot:join(root,'homes'),stateBackend:'local'}}});
  const {budgetRedis}=await import('../lib/billing/budget.js');
  const {keyringStorageKey,readKeyring}=await import('../lib/credentials/keyring.js');
  const {handleKeyringCommand}=await import('../lib/response/keyring/res.js');
  const scope={platform,userId:'100',channelId:`private:${JSON.stringify([platform,'100'])}`};
  const event=app.events.privateMessage({}, {Platform:platform,UserId:'100',IsMaster:false});
  const grants=Array.from({length:6},(_,index)=>({id:index+1,keyId:1,channelId:`group-${index}`,token:`grant-${index}`}));
  try {
    await app.invoke(event,async()=>{
      await (await budgetRedis()).set(keyringStorageKey(scope),JSON.stringify({next:7,keys:[],grants}));
    },'alemonjs-agent-link');
    const run=async(text)=>{
      const sent=[];
      await app.invoke({...event,MessageText:text},()=>handleKeyringCommand({...event,MessageText:text},{send:async payload=>{sent.push({...payload,format:payload.format?.value ?? payload.format});return {code:200};}}),'alemonjs-agent-link');
      return JSON.stringify(sent);
    };
    const second=await run('/授权记录 2');
    assert.match(second,/记录 6/);
    assert.doesNotMatch(second,/"value":"记录 1"/);
    assert.match(second,/第 2\/2 页/);
    const limit=await run('/授权记录 上限 6');
    assert.match(limit,/group-5/);
    assert.match(limit,/授权记录 2/);
    const removed=await run('/授权记录 移除 6');
    assert.match(removed,/本人钥匙及其他群授权保留/);
    assert.match(removed,/授权记录 1/);
    await app.invoke(event,async()=>assert.equal((await readKeyring(scope)).ring.grants.length,5),'alemonjs-agent-link');
  } finally {await app.invoke(event,async()=>{await (await budgetRedis()).del(keyringStorageKey(scope));},'alemonjs-agent-link');await app.dispose();globalThis.ioRedis=previousRedis;await redis.quit();await rm(root,{recursive:true,force:true});}
});
