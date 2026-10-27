import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BiliCommentLedger } from '../lib/bili/comment-ledger.js';
import { createBiliClient } from '../lib/bili/client.js';
import { biliModule } from '../lib/modules/bili.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { runModuleTurn } from '../lib/agent/turn.js';
import { getModuleRuntime } from '../lib/agent/modules.js';

const context = (id, overrides = {}) => ({ platform: 'onebot', channelId: 'private:owner', userId: 'owner', inputId: id,
  private: true, owner: true, userText: '帮我在这个视频下发一条评论', autonomous: false,
  capabilities: { chat: true, web: false, files: false, terminal: false }, signal: new AbortController().signal, ...overrides });
const cookie = 'SESSDATA=example; bili_jct=csrf-example';

test('persistent ledger prevents replay, different comments, concurrent requests and ambiguous retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-ledger-'));
  const ledger = new BiliCommentLedger(root);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const operation = { aid: 123, text: '好看' };
  const limits = { max: 2, cooldown: 0 };
  try {
    const first = ledger.run(context('a'), 'account-123', operation, limits, async () => { calls++; await pending; return 'confirmed'; });
    const during = await ledger.run(context('a'), 'account-123', operation, limits, async () => { calls++; return 'confirmed'; });
    assert.equal(during.state, 'unknown');
    assert.equal((await ledger.run(context('a'), 'account-123', { ...operation, text: '不同' }, limits, async () => 'confirmed')).state, 'rejected');
    release();
    assert.equal((await first).state, 'confirmed');
    assert.equal((await ledger.run(context('b'), 'account-123', operation, limits, async () => { calls++; throw Error('connection lost'); })).state, 'unknown');
    ledger.close();
    const reopened = new BiliCommentLedger(root);
    try {
      assert.equal((await reopened.run(context('a'), 'account-123', operation, limits, async () => { calls++; return 'confirmed'; })).state, 'confirmed');
      assert.equal((await reopened.run(context('b'), 'account-123', operation, limits, async () => { calls++; return 'confirmed'; })).state, 'unknown');
      assert.equal((await reopened.run(context('c'), 'account-123', operation, limits, async () => { calls++; return 'confirmed'; })).state, 'rejected');
      assert.equal(calls, 2);
    } finally { reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('comment cooldown applies across different request IDs for one account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-cooldown-'));
  const ledger = new BiliCommentLedger(root);
  let calls = 0;
  try {
    const action = { aid: 42, text: '你好' };
    const limits = { max: 5, cooldown: 60 };
    assert.equal((await ledger.run(context('one'), '123', action, limits, async () => { calls++; return 'confirmed'; })).state, 'confirmed');
    assert.equal((await ledger.run(context('two'), '123', action, limits, async () => { calls++; return 'confirmed'; })).state, 'rejected');
    assert.equal(calls, 1);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('model tool loop receives actual Bilibili comment confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-comment-turn-'));
  const oldFetch = globalThis.fetch;
  const oldConfig = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': {
    apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'), modules: { settings: { bili: { enabled: true, allowComments: true, dryRun: false, cookie } } }
  } } };
  const config = getDSHConfig();
  let modelCalls = 0;
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, mid: 123, wbi_img: {
      img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png`
    } } });
    if (String(url).includes('/wbi/view')) return Response.json({ code: 0, data: { bvid: 'BV1234567890', aid: 123, cid: 456 } });
    if (String(url).endsWith('/reply/add')) { posts++; return Response.json({ code: 0, data: { rpid: 99 } }); }
    const body = JSON.parse(init.body);
    modelCalls++;
    assert.ok(body.tools.some(tool => tool.function.name === 'bili_comment'));
    if (modelCalls === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: 'comment', type: 'function', function: { name: 'bili_comment', arguments: JSON.stringify({ link: 'BV1234567890', text: '好看' }) } }
    ] } }] });
    assert.equal(JSON.parse(body.messages.find(item => item.role === 'tool').content).state, 'confirmed');
    return Response.json({ choices: [{ message: { content: '评论已发布。' } }] });
  };
  let answer = '';
  try {
    await runModuleTurn({ config, sessionId: 'test-comment', input: '帮我在视频下发一条评论', context: context('turn-1'),
      onEvent: async event => { if (event.type === 'content') answer += event.content; } });
    assert.equal(posts, 1);
    assert.equal(modelCalls, 2);
    assert.equal(answer, '评论已发布。');
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.fetch = oldFetch;
    globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test('Bilibili posting uses CSRF, treats explicit rejection and lost response separately', async () => {
  let result = { code: 0, data: { rpid: 456 } };
  let captured;
  const fetcher = async (url, init) => {
    captured = { url, init };
    if (result === null) throw new Error('timeout');
    return Response.json(result);
  };
  const client = createBiliClient({ cookie, timeoutMs: 5000 }, fetcher);
  assert.equal(await client.postComment(123, '你好', new AbortController().signal), 'confirmed');
  assert.equal(captured.url, 'https://api.bilibili.com/x/v2/reply/add');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.body.get('csrf'), 'csrf-example');
  assert.equal(captured.init.body.get('message'), '你好');
  result = { code: -352 };
  assert.equal(await client.postComment(123, '你好', new AbortController().signal), 'rejected');
  result = { code: 0, data: {} };
  assert.equal(await client.postComment(123, '你好', new AbortController().signal), 'unknown');
  result = null;
  assert.equal(await client.postComment(123, '你好', new AbortController().signal), 'unknown');
});

test('only an explicit owner request can preview or publish; dry run is the default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-comment-'));
  const oldFetch = globalThis.fetch;
  const config = getDSHConfig({ workspaceRoot: join(root, 'work'), stateBackend: 'local' });
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, mid: 123, wbi_img: {
      img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png`
    } } });
    if (String(url).includes('/wbi/view')) return Response.json({ code: 0, data: { bvid: 'BV1234567890', aid: 123, cid: 456, title: '标题' } });
    if (String(url).endsWith('/reply/add')) { posts++; assert.equal(init.body.get('message'), '好看'); return Response.json({ code: 0, data: { rpid: 99 } }); }
    throw new Error('unexpected');
  };
  const setup = settings => { const tools = []; biliModule(config).setup({ settings, tool: value => tools.push(value) }); return tools.find(item => item.name === 'bili_comment'); };
  try {
    const preview = setup({ enabled: true, allowComments: true, cookie });
    const args = { link: 'BV1234567890', text: '好看' };
    assert.equal(preview.available(context('a', { owner: false })), false);
    assert.equal((await preview.execute(args, context('a', { userText: '不要帮我发表评论' }))).state, 'rejected');
    assert.equal((await preview.execute(args, context('a', { userText: '这个评论写得怎么样' }))).state, 'rejected');
    assert.equal((await preview.execute(args, context('a'))).state, 'preview');
    assert.equal(posts, 0);
    const live = setup({ enabled: true, allowComments: true, cookie, dryRun: false, commentCooldownSeconds: 0 });
    assert.equal((await live.execute(args, context('b'))).state, 'confirmed');
    assert.equal((await live.execute(args, context('b'))).state, 'confirmed');
    assert.equal((await live.execute({ ...args, text: '另一条' }, context('b'))).state, 'rejected');
    assert.equal(posts, 1);
  } finally { globalThis.fetch = oldFetch; await rm(root, { recursive: true, force: true }); }
});
