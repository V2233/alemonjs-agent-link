import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultCode, getConfig } from 'alemonjs';
import { OneBotActions } from '../lib/onebot/actions.js';
import { OneBotError } from '../lib/onebot/connection.js';
import { qzoneModule } from '../lib/modules/qzone.js';
import { PlatformOperationError } from '../lib/platform/client.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { runModuleTurn } from '../lib/agent/turn.js';
import { getModuleRuntime } from '../lib/agent/modules.js';

const ownerEvent = { Platform: 'onebot', BotId: '900', IsPrivate: true, UserId: '100' };
const photo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const context = (id, changes = {}) => ({ platform: 'onebot', botId: '900', channelId: 'private:100', userId: '100',
  private: true, owner: true, inputId: id, userText: '帮我发一条空间说说', autonomous: false,
  capabilities: { chat: true, web: false, files: false, terminal: false }, signal: new AbortController().signal, ...changes });

test('OneBot space adapter enforces account, owner, feature and visibility boundaries', async () => {
  let settings = { enabled: true, allowPost: true, dryRun: false };
  let returnId = true;
  const calls = [];
  const connection = { config: { selfId: '900' }, call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_qzone_feeds') return { feeds: [{ key: 'k', nickname: '朋友', html: '<div>你好</div>', time: 10 }] };
    if (action === 'get_qzone_msg_list') return { msglist: [{ tid: 't', content: '自己的', time: 11 }] };
    if (action === 'send_qzone_msg') return returnId ? { tid: 'post-1' } : {};
    throw new OneBotError('rejected', 1404);
  } };
  const adapter = new OneBotActions(connection, () => ({ owner: id => id === '100', groups: [], disabled: [], qzone: settings }));
  const api = (key, args, event = ownerEvent) => adapter.api({ payload: { event, key: `agentLink.${key}`, params: [args] } });
  const read = await api('qzoneRead', { kind: 'feed' });
  assert.equal(read[0].code, ResultCode.Ok);
  assert.equal(read[0].data.items[0].content.trim(), '你好');
  assert.equal((await api('qzoneRead', { kind: 'own' }))[0].data.items[0].id, 't');
  assert.notEqual((await api('qzonePost', { content: '你好', visibility: 'friends' }, { ...ownerEvent, UserId: '101' }))[0].code, ResultCode.Ok);
  assert.notEqual((await api('qzonePost', { content: '你好', visibility: 'all' }, { ...ownerEvent, IsPrivate: false }))[0].code, ResultCode.Ok);
  assert.notEqual((await api('qzonePost', { content: '你好', visibility: 'invalid' }))[0].code, ResultCode.Ok);
  settings = { enabled: true, allowPost: true, dryRun: true };
  assert.notEqual((await api('qzonePost', { content: '你好', visibility: 'self' }))[0].code, ResultCode.Ok);
  settings = { enabled: true, allowPost: true, dryRun: false };
  const posted = await api('qzonePost', { content: '你好', visibility: 'friends' });
  assert.equal(posted[0].code, ResultCode.Ok);
  assert.deepEqual(calls.at(-1), { action: 'send_qzone_msg', params: { content: '你好', ugc_right: 4 } });
  returnId = false;
  const unknown = await api('qzonePost', { content: '你好', visibility: 'self' });
  assert.notEqual(unknown[0].code, ResultCode.Ok);
  assert.equal(unknown[0].data.kind, 'protocol');
});

test('model tool call crosses the framework bridge and checks OneBot publication receipt', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'qzone-model-'));
  const oldFetch = globalThis.fetch;
  let posts = 0;
  let modelCalls = 0;
  const qzone = { enabled: true, allowPost: true, dryRun: false, cooldownSeconds: 0 };
  const connection = { config: { selfId: '900' }, call: async (action, args) => {
    assert.equal(action, 'send_qzone_msg');
    assert.deepEqual(args, { content: '今天很开心', ugc_right: 4 });
    posts++;
    return { tid: 'post-1' };
  } };
  const adapter = new OneBotActions(connection, () => ({ owner: id => id === '100', groups: [], disabled: [], qzone }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    modelCalls++;
    assert.ok(request.tools.some(tool => tool.function.name === 'qzone_post'));
    if (modelCalls === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: 'post', type: 'function', function: { name: 'qzone_post', arguments: '{"content":"今天很开心"}' } }
    ] } }] });
    assert.equal(JSON.parse(request.messages.find(message => message.role === 'tool').content).state, 'confirmed');
    return Response.json({ choices: [{ message: { content: '说说已发布。' } }] });
  };
  let config;
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': { apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local',
        workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), modules: { settings: { qzone } } } });
      config = getDSHConfig();
      let answer = '';
      await runModuleTurn({ config, sessionId: 'qzone-test', input: '帮我发一条空间说说', context: context('model-1'),
        onEvent: async event => { if (event.type === 'content') answer += event.content; } });
      assert.equal(answer, '说说已发布。');
      assert.equal(posts, 1);
      assert.equal(modelCalls, 2);
    });
  } finally {
    if (config) await (await getModuleRuntime(config)).close();
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('space tools preview by default, enforce direct owner intent, and persist delivery outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qzone-test-'));
  const config = getDSHConfig({ workspaceRoot: join(root, 'work'), stateBackend: 'local' });
  let posts = 0;
  let fail = false;
  const client = () => ({ qzoneRead: async () => ({ items: [{ id: 'a', content: '朋友近况' }] }), qzonePost: async (text, visibility) => {
    posts++;
    assert.equal(text, '你好');
    assert.equal(visibility, 'friends');
    if (fail) throw new PlatformOperationError('timeout');
    return { id: 't1' };
  } });
  const setup = settings => { const tools = []; qzoneModule(config, client).setup({ settings, tool: tool => tools.push(tool) }); return tools; };
  try {
    assert.deepEqual(setup({}), []);
    const tools = setup({ enabled: true, allowPost: true });
    const read = tools.find(t => t.name === 'qzone_read');
    const post = tools.find(t => t.name === 'qzone_post');
    assert.equal(read.available(context('1')), true);
    assert.equal(read.available(context('1', { private: false })), false);
    assert.equal((await read.execute({ kind: 'feed' }, context('1'))).items[0].content, '朋友近况');
    assert.equal((await post.execute({ content: '你好' }, context('1', { userText: '不要发空间说说' }))).state, 'rejected');
    assert.equal((await post.execute({ content: '你好' }, context('1', { userText: '你能发空间说说吗？' }))).state, 'rejected');
    assert.equal((await post.execute({ content: '你好' }, context('1'))).state, 'preview');
    assert.equal(posts, 0);
    const live = setup({ enabled: true, allowPost: true, dryRun: false, cooldownSeconds: 0 }).find(t => t.name === 'qzone_post');
    const args = { content: '你好', visibility: 'all' };
    assert.equal((await live.execute(args, context('2'))).state, 'confirmed');
    assert.equal((await live.execute(args, context('2'))).state, 'confirmed');
    assert.equal((await live.execute({ content: '另一条' }, context('2'))).state, 'rejected');
    fail = true;
    assert.equal((await live.execute(args, context('3'))).state, 'unknown');
    assert.equal((await live.execute(args, context('3'))).state, 'unknown');
    assert.equal(posts, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('space interaction adapter maps observed targets to native detail, comment and like actions', async () => {
  let settings = { enabled: true, allowInteract: true, dryRun: false };
  const calls = [];
  const connection = { config: { selfId: '900' }, call: async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_qzone_feeds') return { feeds: [{ key: 'tid1', uin: 123, appid: 311, nickname: '朋友', html: '今日', time: 1234 }, { key: 'photo', uin: 123, appid: 7, time: 1234 }] };
    if (action === 'get_qzone_msg_detail') return { content: '今日', comments: [{ comment_id: 42, name: '甲', content: '不错', replies: [{ name: '乙', content: '是呀' }] }] };
    return null;
  } };
  const adapter = new OneBotActions(connection, () => ({ owner: id => id === '100', groups: [], disabled: [], qzone: settings }));
  const call = (key, args) => adapter.api({ payload: { event: ownerEvent, key: `agentLink.${key}`, params: [args] } });
  const feed = await call('qzoneRead', { kind: 'feed' });
  assert.equal(feed[0].data.items[0].authorId, '123');
  assert.equal(feed[0].data.items[0].interactable, true);
  assert.equal(feed[0].data.items[1].interactable, false);
  assert.equal(feed[0].data.items[0].time, 1234);
  const detail = await call('qzoneDetail', { id: 'tid1', authorId: '123' });
  assert.equal(detail[0].data.comments[0].replies[0].content, '是呀');
  assert.deepEqual(calls.at(-1), { action: 'get_qzone_msg_detail', params: { tid: 'tid1', target_uin: 123, num: 30 } });
  assert.equal((await call('qzoneInteract', { id: 'tid1', authorId: '123', action: 'comment', content: '不错' }))[0].code, ResultCode.Ok);
  assert.deepEqual(calls.at(-1), { action: 'comment_qzone', params: { tid: 'tid1', target_uin: 123, content: '不错' } });
  assert.equal((await call('qzoneInteract', { id: 'tid1', authorId: '123', action: 'like', time: 1234 }))[0].code, ResultCode.Ok);
  assert.deepEqual(calls.at(-1), { action: 'like_qzone', params: { tid: 'tid1', target_uin: 123, abstime: 1234 } });
  settings = { ...settings, dryRun: true };
  assert.notEqual((await call('qzoneInteract', { id: 'tid1', authorId: '123', action: 'like', time: 1234 }))[0].code, ResultCode.Ok);
});

test('interaction uses only observed session targets and preserves uncertain results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qzone-interact-'));
  const config = getDSHConfig({ workspaceRoot: join(root, 'work'), stateBackend: 'local' });
  let calls = 0;
  let fail = false;
  const client = () => ({ qzoneRead: async () => ({ items: [{ id: 'tid1', authorId: '123', interactable: true, time: 1234, content: '朋友近况' }] }),
    qzoneDetail: async (id, authorId) => ({ content: `${id}:${authorId}`, comments: [] }),
    qzoneInteract: async args => { calls++; assert.equal(args.authorId, '123'); if (fail) throw new PlatformOperationError('timeout'); return { ok: true }; } });
  const tools = [];
  qzoneModule(config, client).setup({ settings: { enabled: true, allowInteract: true, dryRun: false, cooldownSeconds: 0 }, tool: tool => tools.push(tool) });
  const read = tools.find(t => t.name === 'qzone_read');
  const detail = tools.find(t => t.name === 'qzone_detail');
  const interact = tools.find(t => t.name === 'qzone_interact');
  const like = context('one', { userText: '帮我给这条点赞' });
  try {
    assert.equal((await interact.execute({ id: 'tid1', action: 'like' }, like)).state, 'rejected');
    await read.execute({ kind: 'feed' }, like);
    assert.equal((await detail.execute({ id: 'tid1' }, like)).content, 'tid1:123');
    assert.equal((await detail.execute({ id: 'tid1' }, { ...like, userId: 'other' })).ok, false);
    assert.equal((await interact.execute({ id: 'tid1', action: 'like' }, { ...like, userText: '不要点赞' })).state, 'rejected');
    assert.equal((await interact.execute({ id: 'tid1', action: 'like' }, { ...like, userText: '你能帮我点赞吗？' })).state, 'rejected');
    assert.equal((await interact.execute({ id: 'tid1', action: 'like' }, like)).state, 'confirmed');
    assert.equal((await interact.execute({ id: 'tid1', action: 'like' }, like)).state, 'confirmed');
    fail = true;
    const comment = context('two', { userText: '帮我写一条评论' });
    assert.equal((await interact.execute({ id: 'tid1', action: 'comment', content: '真好' }, comment)).state, 'unknown');
    assert.equal((await interact.execute({ id: 'tid1', action: 'comment', content: '真好' }, comment)).state, 'unknown');
    assert.equal(calls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model reads a feed then comments through the OneBot bridge', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'qzone-model-interact-'));
  const oldFetch = globalThis.fetch;
  const qzone = { enabled: true, allowInteract: true, dryRun: false, cooldownSeconds: 0 };
  let comments = 0;
  let rounds = 0;
  const connection = { config: { selfId: '900' }, call: async (action, args) => {
    if (action === 'get_qzone_feeds') return { feeds: [{ key: 'tid1', uin: 123, appid: 311, nickname: '朋友', html: '今天很开心', time: 1234 }] };
    assert.equal(action, 'comment_qzone');
    assert.deepEqual(args, { tid: 'tid1', target_uin: 123, content: '真好' });
    comments++;
    return null;
  } };
  const adapter = new OneBotActions(connection, () => ({ owner: id => id === '100', groups: [], disabled: [], qzone }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    rounds++;
    assert.ok(request.tools.some(tool => tool.function.name === 'qzone_interact'));
    if (rounds === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: 'read', type: 'function', function: { name: 'qzone_read', arguments: '{"kind":"feed"}' } }
    ] } }] });
    const result = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
    if (rounds === 2) {
      assert.equal(result.items[0].id, 'tid1');
      return Response.json({ choices: [{ message: { content: null, tool_calls: [
        { id: 'comment', type: 'function', function: { name: 'qzone_interact', arguments: '{"id":"tid1","action":"comment","content":"真好"}' } }
      ] } }] });
    }
    assert.equal(result.state, 'confirmed');
    return Response.json({ choices: [{ message: { content: '评论已提交。' } }] });
  };
  let config;
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': { apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local',
        workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), modules: { settings: { qzone } } } });
      config = getDSHConfig();
      let answer = '';
      await runModuleTurn({ config, sessionId: 'qzone-interact', input: '帮我给好友动态写一条评论',
        context: context('model-interact', { userText: '帮我给好友动态写一条评论' }),
        onEvent: async event => { if (event.type === 'content') answer += event.content; } });
      assert.equal(answer, '评论已提交。');
      assert.equal(rounds, 3);
      assert.equal(comments, 1);
    });
  } finally {
    if (config) await (await getModuleRuntime(config)).close();
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('space images require owner intent and actual valid current attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qzone-images-'));
  const config = getDSHConfig({ workspaceRoot: join(root, 'work'), stateBackend: 'local' });
  const seen = [];
  const client = () => ({ qzonePost: async (_text, _visibility, images) => { seen.push(images); return { id: 't1' }; } });
  const tools = [];
  qzoneModule(config, client).setup({ settings: { enabled: true, allowPost: true, dryRun: false, cooldownSeconds: 0 }, tool: tool => tools.push(tool) });
  const post = tools.find(tool => tool.name === 'qzone_post');
  const withImages = context('img', { userText: '发一条空间说说，带上这张图片', onCurrentImages: async () => [photo] });
  try {
    assert.equal((await post.execute({ content: '好看', includeImages: true }, context('no-ask', { onCurrentImages: async () => [photo] }))).state, 'rejected');
    assert.equal((await post.execute({ content: '好看', includeImages: true }, context('describe-only', { userText: '发一条空间说说，讲讲这张图片', onCurrentImages: async () => [photo] }))).state, 'rejected');
    assert.equal((await post.execute({ content: '好看' }, { ...withImages, inputId: 'missing', onCurrentImages: async () => [] })).state, 'rejected');
    assert.equal((await post.execute({ content: '好看' }, { ...withImages, inputId: 'invalid', onCurrentImages: async () => [Buffer.from('not image')] })).state, 'rejected');
    assert.equal(seen.length, 0);
    assert.equal((await post.execute({ content: '好看', includeImages: false }, withImages)).state, 'confirmed');
    assert.deepEqual(seen[0], [photo]);
    assert.equal((await post.execute({ content: '好看' }, withImages)).state, 'confirmed');
    const different = Buffer.concat([photo, Buffer.from('changed')]);
    assert.equal((await post.execute({ content: '好看' }, { ...withImages, onCurrentImages: async () => [different] })).state, 'rejected');
    assert.equal(seen.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model posts actual current attachment bytes through OneBot', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'qzone-image-model-'));
  const oldFetch = globalThis.fetch;
  const qzone = { enabled: true, allowPost: true, dryRun: false, cooldownSeconds: 0 };
  let posts = 0;
  let rounds = 0;
  const connection = { config: { selfId: '900' }, call: async (action, args) => {
    assert.equal(action, 'send_qzone_msg');
    assert.deepEqual(args, { content: '今天很开心', ugc_right: 4, images: [`base64://${photo.toString('base64')}`] });
    posts++;
    return { tid: 'post-image' };
  } };
  const adapter = new OneBotActions(connection, () => ({ owner: id => id === '100', groups: [], disabled: [], qzone }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    rounds++;
    if (rounds === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: 'post', type: 'function', function: { name: 'qzone_post', arguments: '{"content":"今天很开心","includeImages":true}' } }
    ] } }] });
    assert.equal(JSON.parse(request.messages.find(message => message.role === 'tool').content).state, 'confirmed');
    return Response.json({ choices: [{ message: { content: '已发布。' } }] });
  };
  let config;
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': { apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local',
        workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), modules: { settings: { qzone } } } });
      config = getDSHConfig();
      await runModuleTurn({ config, sessionId: 'qzone-image', input: '发一条空间说说，带上这张图片',
        context: context('image-turn', { userText: '发一条空间说说，带上这张图片' }), onCurrentImages: async () => [photo], onEvent: async () => {} });
      assert.equal(posts, 1);
      assert.equal(rounds, 2);
    });
  } finally {
    if (config) await (await getModuleRuntime(config)).close();
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('OneBot rejects invalid or oversized encoded space images before sending', async () => {
  let calls = 0;
  const connection = { config: { selfId: '900' }, call: async () => { calls++; return { tid: 'ok' }; } };
  const adapter = new OneBotActions(connection, () => ({ owner: id => id === '100', groups: [], disabled: [], qzone: { enabled: true, allowPost: true, dryRun: false } }));
  const post = images => adapter.api({ payload: { event: ownerEvent, key: 'agentLink.qzonePost', params: [{ content: 'a', visibility: 'friends', images }] } });
  assert.notEqual((await post([Buffer.from('not image').toString('base64')]))[0].code, ResultCode.Ok);
  assert.notEqual((await post(['bad!']))[0].code, ResultCode.Ok);
  assert.notEqual((await post(Array(5).fill(photo.toString('base64'))))[0].code, ResultCode.Ok);
  assert.equal(calls, 0);
});
