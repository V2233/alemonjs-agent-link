import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from 'alemonjs/testing';
import router from '../lib/router.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getGroupSettingsStore } from '../lib/social/group-settings.js';
import { getPersonaStore } from '../lib/companion/personas.js';
import { getMemoryStore } from '../lib/memory/store.js';
import {getGroupTopicStore,groupTopicId} from '../lib/group-topics/store.js';
import {newsCandidate} from '../lib/group-topics/news.js';

const commandsIn = value => {
  const found = new Set();
  const visit = node => {
    if (typeof node === 'string' && node.startsWith('/')) found.add(node);
    else if (node && typeof node === 'object') for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return found;
};

test('rendered paginator commands round-trip through the actual router for word lists, templates and private memories', async () => {
  const root = await mkdtemp(join(tmpdir(),'bubble-router-pages-'));
  const settings = { stateBackend:'local',workspaceRoot:join(root,'work'),dshHomeRoot:join(root,'home'),privateChatAccess:'all',modules:{settings:{memory:{automatic:false}}} };
  const config = getDSHConfig(settings);
  const groups = getGroupSettingsStore(config), personas = getPersonaStore(config), memories = getMemoryStore(config);
  const topics = getGroupTopicStore(config);
  const app = createTestApp({config:{'alemonjs-agent-link':settings}});
  let index = 0;
  const run = async (command, privateChat) => {
    await app.clock.advance(2000);
    const result = await app.dispatch({ name:privateChat?'private.message.create':'message.create',Platform:'qq-bot',BotId:'bot',UserId:'u',UserKey:'u',ChannelId:privateChat?undefined:'g',IsPrivate:privateChat,IsMaster:true,IsBot:false,MessageId:`pagination-${++index}`,MessageText:command,MessageMentions:[] });
    assert.equal(result.errors.length,0);
    assert.equal(result.messages.length,1);
    const payload = result.actions.map(a=>a.request.payload?.params);
    assert.doesNotMatch(JSON.stringify(payload),/BT.group/);
    return {text:JSON.stringify(result.messages),commands:commandsIn(payload)};
  };
  try {
    groups.update('qq-bot','g','u',{wakeNames:Array.from({length:7},(_,i)=>`词${i}`)});
    for(let i=0;i<8;i++) await personas.save({id:`page-${i}`,name:`人格${i}`,prompt:'保持简洁'});
    const scope={platform:'qq-bot',botId:'bot',channelId:'private:["qq-bot","u"]'};
    memories.observe(scope);
    for(let i=1;i<=7;i++) {
      const refs=[{seq:i,text:`偏好${i}`,speaker:'甲',speakerId:'u',timestamp:Date.now()}];
      memories.applyExtraction(scope,memories.state(scope),[{action:'add',text:`偏好${i}`,kind:'fact',sourceSeqs:[i],evidence:refs[0].text,tags:[],importance:0.5,confidence:0.9}],refs,i,false);
    }
    const topicScope=groupTopicId('qq-bot','bot','g');
    topics.saveProfile({id:topicScope,platform:'qq-bot',botId:'bot',channelId:'g',positioning:'游戏群',tags:['游戏'],blockedTags:[],enabled:true,shareOut:false,receiveShared:true});
    const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    for(let i=0;i<5;i++)topics.addTopic(newsCandidate(`https://example.com/page-news-${i}`,day,['游戏'],`游戏新闻${i}`));
    await app.mount({response:router});
    for(const [base,privateChat] of [['/群设置 唤醒词 查看',false],['/人格 管理',true],['/记忆',true],['/群设置 话题 候选',false]]) {
      const first=await run(base,privateChat);
      const next=`${base} 2`;
      assert.ok(first.commands.has(next),`missing next command for ${base}`);
      const second=await run([...first.commands].find(value=>value===next),privateChat);
      assert.match(second.text,/第 2\//);
      const previous=`${base} 1`;
      assert.ok(second.commands.has(previous));
      const back=await run([...second.commands].find(value=>value===previous),privateChat);
      assert.match(back.text,/第 1\//);
    }
    const newsCommand=`/群设置 话题 新闻 https://example.com/new-entry ${day} 游戏 已核实的测试摘要`;
    const saved=await run(newsCommand,false);
    assert.match(saved.text,/已录入公共新闻候选池/);
    assert.ok(saved.commands.has('/群设置 话题 候选'));
    const duplicate=await run(newsCommand,false);
    assert.match(duplicate.text,/未重复录入/);
    assert.equal(topics.topics().length,6);
  } finally {await app.dispose();topics.close();groups.close();personas.close();memories.close();await rm(root,{recursive:true,force:true});}
});

test('key library paginator commands round-trip through the router with actual encrypted Redis entries', {skip:!process.env.AGENT_LINK_TEST_REDIS_CONFIG}, async () => {
  const {readFile} = await import('node:fs/promises');
  const {default:YAML} = await import('yaml');
  const {default:Redis} = await import('ioredis');
  const {randomUUID} = await import('node:crypto');
  const {changeKeyring} = await import('../lib/credentials/keyring.js');
  const root=await mkdtemp(join(tmpdir(),'key-pages-router-'));
  const connection=YAML.parse(await readFile(process.env.AGENT_LINK_TEST_REDIS_CONFIG,'utf8')).db.redis;
  const redis=new Redis({...connection,keyPrefix:`key-pages:${randomUUID()}:`,maxRetriesPerRequest:0,retryStrategy:()=>null});
  redis.on('error',()=>{});
  await redis.ping();
  const oldRedis=globalThis.ioRedis, oldFile=process.env.AGENT_LINK_PERSONAL_KEY_FILE;
  globalThis.ioRedis=redis;
  process.env.AGENT_LINK_PERSONAL_KEY_FILE=join(root,'master.key');
  const app=createTestApp({config:{'alemonjs-agent-link':{stateBackend:'local',workspaceRoot:join(root,'work'),dshHomeRoot:join(root,'home')}}});
  try {
    const privateEvent=app.events.privateMessage({}, {Platform:'qq-bot',BotId:'bot',UserId:'u',IsMaster:true});
    await app.invoke(privateEvent,async()=>{
      for(let i=0;i<8;i++)await changeKeyring({platform:'qq-bot',userId:'u',channelId:'private:["qq-bot","u"]'},'add',`sk-fixture-page-${i}`);
    },'alemonjs-agent-link');
    await app.mount({response:router});
    let index=0;
    const run=async(command)=>{
      await app.clock.advance(2000);
      const result=await app.dispatch({name:'message.create',Platform:'qq-bot',BotId:'bot',UserId:'u',UserKey:'u',ChannelId:'g',IsPrivate:false,IsMaster:true,IsBot:false,IsAdmin:true,Role:'admin',MessageId:`key-pages-${++index}`,MessageText:command,MessageMentions:[]});
      assert.equal(result.errors.length,0);
      assert.equal(result.messages.length,1);
      const payload=result.actions.map(a=>a.request.payload?.params);
      assert.doesNotMatch(JSON.stringify(payload),/sk-fixture|BT.group/);
      return {text:JSON.stringify(result.messages),commands:commandsIn(payload)};
    };
    const first=await run('/我的钥匙');
    assert.ok(first.commands.has('/我的钥匙 2'));
    const second=await run([...first.commands].find(value=>value==='/我的钥匙 2'));
    assert.match(second.text,/第 2\/2 页/);
    assert.ok(second.commands.has('/我的钥匙 1'));
    assert.match((await run([...second.commands].find(value=>value==='/我的钥匙 1'))).text,/第 1\/2 页/);
  } finally {
    await app.dispose();globalThis.ioRedis=oldRedis;
    if(oldFile===undefined)delete process.env.AGENT_LINK_PERSONAL_KEY_FILE;else process.env.AGENT_LINK_PERSONAL_KEY_FILE=oldFile;
    await redis.quit();await rm(root,{recursive:true,force:true});
  }
});
