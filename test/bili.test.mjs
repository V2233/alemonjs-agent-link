import test from 'node:test';
import assert from 'node:assert/strict';
import { createBiliClient, videoId, wbiQuery, biliOptions } from '../lib/bili/client.js';
import { biliModule } from '../lib/modules/bili.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { runModuleTurn } from '../lib/agent/turn.js';

const bv = 'BV1234567890';
const nav = { data: { wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } } };
const ok = data => Response.json({ code: 0, data });
const signal = () => new AbortController().signal;

test('identifiers, short links and WBI signing are bounded', () => {
  assert.deepEqual(videoId(`看看 https://www.bilibili.com/video/${bv}`), { bvid: bv });
  assert.deepEqual(videoId('av12345'), { aid: '12345' });
  assert.deepEqual(videoId('https://b23.tv/Ab3'), { short: 'https://b23.tv/Ab3' });
  assert.equal(videoId('https://evil.example/test'), null);
  const query = wbiQuery({ keyword: '鲸鱼', page: 1 }, 'a'.repeat(32), 'b'.repeat(32), 1000000);
  assert.match(query, /^keyword=%E9%B2%B8%E9%B1%BC&page=1&wts=1000&w_rid=[a-f0-9]{32}$/u);
  assert.throws(() => wbiQuery({}, '', ''));
  assert.throws(() => biliOptions({ enabled: true, cookie: 'x\nheader: value' }));
});

test('video reading combines signed metadata, subtitle and comments without leaking cookie to CDN', async () => {
  const visited = [];
  const fetcher = async (url, init) => {
    visited.push(String(url));
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Cookie, 'SESSDATA=test');
    if (url.endsWith('/nav')) return Response.json(nav);
    assert.ok(new URL(url).searchParams.get('w_rid'));
    if (url.includes('/wbi/view')) return ok({ bvid: bv, aid: 123, cid: 456, title: '标题', desc: '简介', owner: { name: '作者' }, duration: 8, stat: { view: 42 } });
    if (url.includes('/player/wbi/v2')) return ok({ subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//i0.hdslb.com/subtitle.json' }] } });
    if (url.includes('/reply/wbi/main')) return ok({ replies: [{ member: { uname: '观众' }, content: { message: '好看' }, like: 3 }] });
    if (url.includes('/search/type')) return ok({ result: [{ bvid: bv, title: '<em>鲸鱼</em>', play: 21, author: '作者' }] });
    throw new Error('unexpected request');
  };
  const downloader = async (url, config) => {
    assert.equal(url, 'https://i0.hdslb.com/subtitle.json');
    assert.deepEqual(config.allowedHosts, ['i0.hdslb.com']);
    return Buffer.from(JSON.stringify({ body: [{ content: '真实字幕' }] }));
  };
  const client = createBiliClient({ cookie: 'SESSDATA=test', timeoutMs: 5000 }, fetcher, downloader);
  const result = await client.watch(bv, signal());
  assert.equal(result.video.title, '标题');
  assert.equal(result.subtitles.text, '真实字幕');
  assert.equal(result.comments.items[0].text, '好看');
  assert.match(result.notice, /不代表已经观看画面/);
  assert.equal((await client.search('鲸鱼', signal())).items[0].title, '鲸鱼');
  assert.ok(visited.every(url => new URL(url).hostname === 'api.bilibili.com'));
});

test('short-link destinations are checked and partial sources never masquerade as viewed content', async () => {
  let target = `https://www.bilibili.com/video/${bv}`;
  const fetcher = async url => {
    if (url.startsWith('https://b23.tv/')) return new Response(null, { status: 302, headers: { location: target } });
    if (url.endsWith('/nav')) return Response.json(nav);
    if (url.includes('/wbi/view')) return ok({ bvid: bv, aid: 123, cid: 456, title: '视频' });
    if (url.includes('/player/')) return ok({ subtitle: { subtitles: [] } });
    if (url.includes('/reply/')) return Response.json({ code: -352 });
    throw new Error('unexpected request');
  };
  const client = createBiliClient({ cookie: '', timeoutMs: 5000 }, fetcher);
  const result = await client.watch('https://b23.tv/Ab3', signal());
  assert.equal(result.subtitles.status, 'not_available');
  assert.equal(result.comments.status, 'unavailable');
  target = `https://evil.example/video/${bv}`;
  await assert.rejects(client.watch('https://b23.tv/Ab3', signal()), /跳转地址/);
  const aborted = new AbortController();
  aborted.abort();
  const cancellingClient = createBiliClient({ cookie: '', timeoutMs: 5000 }, async (_url, init) => { init.signal.throwIfAborted(); });
  await assert.rejects(cancellingClient.watch(bv, aborted.signal));
});

test('module is opt-in and tools are unavailable for autonomous turns', () => {
  const tools = [];
  biliModule().setup({ settings: {}, tool: item => tools.push(item) });
  assert.equal(tools.length, 0);
  biliModule().setup({ settings: { enabled: true }, tool: item => tools.push(item) });
  assert.deepEqual(tools.map(item => item.name), ['bili_watch', 'bili_search']);
  assert.ok(tools.every(item => item.readOnly && !item.available({ autonomous: true })));
});

test('model reads the actual Bilibili result through a normal tool turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-turn-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': {
    apiKey: 'test', model: 'test', runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'),
    dshHomeRoot: join(root, 'home'), modules: { settings: { bili: { enabled: true } } }
  } } };
  const config = getDSHConfig();
  let calls = 0;
  let answer = '';
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/nav')) return Response.json(nav);
    if (String(url).includes('/wbi/view')) return ok({ bvid: bv, aid: 123, cid: 456, title: '真实标题' });
    if (String(url).includes('/player/')) return ok({ subtitle: { subtitles: [] } });
    if (String(url).includes('/reply/')) return ok({ replies: [] });
    calls++;
    const request = JSON.parse(init.body);
    assert.ok(request.tools.some(tool => tool.function.name === 'bili_watch'));
    if (calls === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: 'watch', type: 'function', function: { name: 'bili_watch', arguments: JSON.stringify({ link: bv }) } }
    ] } }] });
    const result = JSON.parse(request.messages.find(item => item.role === 'tool').content);
    assert.equal(result.video.title, '真实标题');
    assert.equal(result.subtitles.status, 'not_available');
    return Response.json({ choices: [{ message: { content: '标题是真实标题，未获取到字幕。' } }] });
  };
  try {
    await runModuleTurn({
      config, sessionId: 'bili-test', input: `看看${bv}`,
      context: { channelId: 'private:test', userId: '1', platform: 'onebot', private: true, owner: false,
        userText: `看看${bv}`, capabilities: { chat: true, web: false, files: false, terminal: false }, signal: signal() },
      onEvent: async event => { if (event.type === 'content') answer += event.content; }
    });
    assert.equal(calls, 2);
    assert.equal(answer, '标题是真实标题，未获取到字幕。');
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = previous;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});
