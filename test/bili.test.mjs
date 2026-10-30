import { getProactiveStore } from '../lib/proactive/store.js';
import { proactiveOptions } from '../lib/proactive/options.js';
import { proactiveChannel } from '../lib/proactive/control.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBiliClient, videoId, wbiQuery, biliOptions } from '../lib/bili/client.js';
import { biliModule } from '../lib/modules/bili.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { executeTool } from '../lib/agent/modules.js';
import { runModuleTurn } from '../lib/agent/turn.js';
import { getMemoryStore } from '../lib/memory/store.js';

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
  for (const value of [0, 4, 1.5, '2']) assert.throws(() => biliOptions({ dailyBrowseMaxReads: value }));
  assert.equal(biliOptions({}).dailyBrowseMaxReads, 2);
});

test('video reading combines signed metadata, subtitle and comments without leaking cookie to CDN', async () => {
  const visited = [];
  const fetcher = async (url, init) => {
    visited.push(String(url));
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Cookie, 'SESSDATA=test');
    if (url.endsWith('/nav')) return Response.json(nav);
    assert.ok(new URL(url).searchParams.get('w_rid'));
    if (url.includes('/wbi/view'))
      return ok({ bvid: bv, aid: 123, cid: 456, title: '标题', desc: '简介', owner: { name: '作者' }, duration: 8, stat: { view: 42 } });
    if (url.includes('/player/wbi/v2')) return ok({ subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//i0.hdslb.com/subtitle.json' }] } });
    if (url.includes('/reply/wbi/main')) return ok({ replies: [{ member: { uname: '观众' }, content: { message: '好看' }, like: 3 }] });
    if (url.includes('/search/type')) return ok({ result: [{ bvid: bv, title: '<em>鲸鱼</em>', play: 21, author: '作者' }] });
    throw new Error('unexpected request');
  };
  const downloader = async (url, config) => {
    assert.equal(url, 'https://i0.hdslb.com/subtitle.json');
    assert.deepEqual(config.allowedHosts, ['i0.hdslb.com']);
    return Buffer.from(JSON.stringify({ body: [{ from: 1, to: 3, content: '真实字幕' }] }));
  };
  const client = createBiliClient({ cookie: 'SESSDATA=test', timeoutMs: 5000 }, fetcher, downloader);
  const result = await client.watch(bv, signal());
  assert.equal(result.video.title, '标题');
  assert.equal(result.subtitles.text, '真实字幕');
  assert.deepEqual(result.subtitles.segments, [{ from: 1, to: 3, text: '真实字幕' }]);
  assert.equal(result.subtitles.truncated, false);
  assert.equal(result.evidence.basis, 'subtitles');
  assert.equal(result.evidence.visualObserved, false);
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
  assert.equal(result.evidence.basis, 'metadata');
  target = `https://evil.example/video/${bv}`;
  await assert.rejects(client.watch('https://b23.tv/Ab3', signal()), /跳转地址/);
  const aborted = new AbortController();
  aborted.abort();
  const cancellingClient = createBiliClient({ cookie: '', timeoutMs: 5000 }, async (_url, init) => {
    init.signal.throwIfAborted();
  });
  await assert.rejects(cancellingClient.watch(bv, aborted.signal));
});

test('module is on by default, can be turned off, and stays read-only outside owner turns', () => {
  const tools = [];
  biliModule().setup({ settings: {}, tool: item => tools.push(item) });
  assert.deepEqual(
    tools.map(item => item.name),
    ['bili_watch', 'bili_search']
  );
  const off = [];
  biliModule().setup({ settings: { enabled: false }, tool: item => off.push(item) });
  assert.equal(off.length, 0);
  assert.ok(tools.every(item => item.readOnly && !item.available({ autonomous: true })));
  const allowed = [];
  biliModule().setup({ settings: { enabled: true, allowProactiveBrowse: true }, tool: item => allowed.push(item) });
  assert.ok(allowed.every(item => item.available({ autonomous: true, private: true, owner: true })));
  assert.ok(allowed.every(item => !item.available({ autonomous: true, private: false, owner: true })));
  assert.ok(allowed.every(item => !item.available({ autonomous: true, private: true, owner: false })));
  assert.throws(() => biliOptions({ enabled: true, allowProactiveBrowse: 'yes' }));
});

test('model reads the actual Bilibili result through a normal tool turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-turn-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        modules: { disabled: ['opinions'], settings: { bili: { enabled: true } } }
      }
    }
  };
  const config = getDSHConfig();
  let calls = 0;
  let answer = '';
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/nav')) return Response.json(nav);
    if (String(url).includes('/wbi/view')) return ok({ bvid: bv, aid: 123, cid: 456, title: '真实标题', desc: '实测鲸鱼资料' });
    if (String(url).includes('/player/')) return ok({ subtitle: { subtitles: [] } });
    if (String(url).includes('/reply/')) return ok({ replies: [{ member: { uname: '观众' }, content: { message: '这是条蓝鲸' } }] });
    calls++;
    const request = JSON.parse(init.body);
    assert.ok(request.tools.some(tool => tool.function.name === 'bili_watch'));
    if (calls === 1)
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'watch', type: 'function', function: { name: 'bili_watch', arguments: JSON.stringify({ link: bv }) } }]
            }
          }
        ]
      });
    if (calls === 2) {
      const result = JSON.parse(request.messages.find(item => item.role === 'tool').content);
      assert.equal(result.video.title, '真实标题');
      assert.equal(result.evidence.basis, 'metadata');
      assert.equal(result.evidence.audienceCommentScope, 'returned_subset');
      assert.equal(result.subtitles.status, 'not_available');
    } else {
      assert.match(JSON.stringify(request.messages), /近期经历/);
      assert.match(JSON.stringify(request.messages), /真实标题/);
      assert.match(JSON.stringify(request.messages), /没有读取视频画面或声音/);
    }
    return Response.json({ choices: [{ message: { content: '标题是真实标题，未获取到字幕。' } }] });
  };
  try {
    await runModuleTurn({
      config,
      sessionId: 'bili-test',
      input: `看看${bv}`,
      context: {
        channelId: 'private:test',
        userId: '1',
        botId: '900',
        inputId: 'message-1',
        platform: 'onebot',
        private: true,
        owner: false,
        userText: `看看${bv}`,
        capabilities: { chat: true, web: false, files: false, terminal: false },
        signal: signal()
      },
      onEvent: async event => {
        if (event.type === 'content') answer += event.content;
      }
    });
    assert.equal(calls, 2);
    assert.equal(answer, '标题是真实标题，未获取到字幕。');
    const store = getMemoryStore(config);
    const scope = { platform: 'onebot', channelId: 'private:test' };
    const experiences = store.list(scope, { status: 'active', subjectId: '900' });
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].origin, 'event');
    assert.match(experiences[0].text, /真实标题/);
    assert.match(experiences[0].text, /实测鲸鱼资料/);
    assert.match(experiences[0].text, /这是条蓝鲸/);
    assert.match(experiences[0].text, /contentBasis.*metadata/);
    assert.match(experiences[0].text, /audienceCommentScope.*returned_subset/);
    assert.deepEqual(store.list({ ...scope, channelId: 'private:other' }), []);
    await runModuleTurn({
      config,
      sessionId: 'bili-next',
      input: '刚刚聊了什么',
      context: {
        channelId: 'private:test',
        userId: '1',
        botId: '900',
        inputId: 'message-2',
        platform: 'onebot',
        private: true,
        owner: false,
        userText: '刚刚聊了什么',
        capabilities: { chat: true, web: false, files: false, terminal: false },
        signal: signal()
      },
      onEvent: async () => {}
    });
    assert.equal(calls, 3);
    assert.equal(store.forget(scope, experiences[0].id, 0), true);
    assert.deepEqual(store.list(scope, { subjectId: '900' }), []);
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = previous;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('opt-in proactive turn searches and reads Bilibili with per-turn bounds and no comment tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-autonomous-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  const bili = { enabled: true, allowProactiveBrowse: true, allowComments: true };
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        modules: { settings: { bili } }
      }
    }
  };
  const config = getDSHConfig();
  let modelCalls = 0,
    searches = 0,
    watched = 0;
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    if (address.endsWith('/nav')) return Response.json(nav);
    if (address.includes('/search/type')) {
      searches++;
      return ok({ result: [{ bvid: bv, title: '小鲸鱼', author: '作者' }] });
    }
    if (address.includes('/wbi/view')) {
      watched++;
      return ok({ bvid: bv, aid: 123, cid: 456, title: '小鲸鱼', desc: '讲鲸鱼的生态' });
    }
    if (address.includes('/player/')) return ok({ subtitle: { subtitles: [] } });
    if (address.includes('/reply/')) return ok({ replies: [] });
    const request = JSON.parse(init.body);
    modelCalls++;
    const names = request.tools.map(tool => tool.function.name);
    assert.ok(names.includes('bili_search') && names.includes('bili_watch'));
    assert.equal(names.includes('bili_comment'), false);
    if (modelCalls === 1)
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 's1', type: 'function', function: { name: 'bili_search', arguments: '{"keyword":"鲸鱼"}' } },
                { id: 's2', type: 'function', function: { name: 'bili_search', arguments: '{"keyword":"海洋"}' } }
              ]
            }
          }
        ]
      });
    if (modelCalls === 2) {
      const results = request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      assert.equal(results[0].ok, true);
      assert.equal(results[1].ok, false);
      return Response.json({
        choices: [
          {
            message: { content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'bili_watch', arguments: JSON.stringify({ link: bv }) } }] }
          }
        ]
      });
    }
    return Response.json({ choices: [{ message: { content: '刚看到一条讲鲸鱼生态的视频，标题挺有意思。' } }] });
  };
  try {
    await runModuleTurn({
      config,
      sessionId: 'bili-auto',
      input: '主动聊个话题',
      context: {
        channelId: 'private:owner',
        userId: '100',
        botId: '900',
        inputId: 'proactive:1',
        platform: 'onebot',
        private: true,
        owner: true,
        autonomous: true,
        userText: '',
        capabilities: { chat: true, web: false, files: false, terminal: false },
        signal: signal()
      },
      onEvent: async () => {}
    });
    assert.equal(modelCalls, 3);
    assert.equal(searches, 1);
    assert.equal(watched, 1);
    const events = getMemoryStore(config).list({ platform: 'onebot', channelId: 'private:owner' }, { subjectId: '900' });
    assert.equal(events.length, 2);
    const reading = events.find(item => item.tags.includes('资料'));
    const reflection = events.find(item => item.tags.includes('阅读感想'));
    assert.match(reading.text, /讲鲸鱼的生态/);
    assert.match(reading.text, /没有读取视频画面或声音/);
    assert.match(reading.text, /audienceCommentScope.*empty_response/);
    assert.equal(reflection.origin, 'diary');
    assert.equal(reflection.kind, 'diary');
    assert.ok(reflection.tags.includes(`reading:${reading.id}`));
    assert.match(reflection.text, /未证明已发送/);
    assert.match(reflection.text, /标题挺有意思/);
    // Continue through production memory tools and runtime context after an actual
    // bili_watch execution (HTTP is a deterministic fixture, not a real account).
    const scope = { platform: 'onebot', channelId: 'private:owner' };
    const store = getMemoryStore(config);
    const item = store.recordSharedThread(scope, '100', {
      text: '一起了解鲸鱼生态资料',
      state: 'agreed',
      sources: [{ seq: 1, speakerId: '100', speaker: '主人', text: '约定一起了解鲸鱼', timestamp: Date.now() }]
    });
    const context = {
      ...scope,
      userId: '100',
      botId: '900',
      private: true,
      owner: true,
      autonomous: false,
      userText: '刚才了解到什么',
      capabilities: { chat: true, web: false, files: false, terminal: false },
      signal: signal()
    };
    const runtime = await getModuleRuntime(config);
    const lease = await runtime.acquire();
    try {
      const link = lease.tools(context).find(tool => tool.name === 'link_shared_execution');
      assert.ok(link);
      await executeTool(link, { id: item.id, expectedRevision: 1, memoryId: reading.id }, context);
      await assert.rejects(executeTool(link, { id: item.id, expectedRevision: 2, memoryId: reflection.id }, context));
      const loaded = await lease.context(context);
      assert.match(loaded, /sharedThreads/);
      assert.match(loaded, new RegExp(reading.id));
      assert.match(loaded, /没有读取视频画面或声音/);
      assert.equal(store.sharedThreads(scope, '100')[0].state, 'agreed');
    } finally {
      await lease.release();
    }
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = previous;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('disabling proactive browsing during a turn blocks later calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-autonomous-disable-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  const enabled = { enabled: true, allowProactiveBrowse: true };
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        modules: { settings: { bili: enabled } }
      }
    }
  };
  const config = getDSHConfig();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('unexpected');
  };
  try {
    const tools = [];
    biliModule(config).setup({ settings: enabled, tool: tool => tools.push(tool) });
    globalThis.__config.value['alemonjs-agent-link'].modules.settings.bili = { ...enabled, allowProactiveBrowse: false };
    const context = { platform: 'onebot', channelId: 'private:owner', userId: '100', owner: true, private: true, autonomous: true, signal: signal() };
    const result = await tools.find(tool => tool.name === 'bili_search').execute({ keyword: '鲸鱼' }, context);
    assert.equal(result.ok, false);
    assert.equal(requests, 0);
  } finally {
    globalThis.__config = previous;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('Bilibili experience is not recorded when automatic memory or chat history is disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-no-experience-'));
  const originalConfig = globalThis.__config;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/nav')) return Response.json(nav);
    if (String(url).includes('/wbi/view')) return ok({ bvid: bv, aid: 123, cid: 456, title: '标题' });
    if (String(url).includes('/player/')) return ok({ subtitle: { subtitles: [] } });
    if (String(url).includes('/reply/')) return ok({ replies: [] });
    throw new Error('unexpected request');
  };
  try {
    for (const modules of [{ settings: { memory: { automatic: false } } }, { disabled: ['chat-history'] }]) {
      globalThis.__config = {
        value: {
          'alemonjs-agent-link': {
            runtimeMode: 'chat-only',
            stateBackend: 'local',
            workspaceRoot: join(root, 'work'),
            dshHomeRoot: join(root, 'home'),
            modules
          }
        }
      };
      const config = getDSHConfig();
      const tools = [];
      biliModule(config).setup({ settings: { enabled: true }, tool: item => tools.push(item) });
      const context = { channelId: 'private:disabled', userId: '1', botId: '900', inputId: 'm1', platform: 'onebot', autonomous: false, signal: signal() };
      assert.equal((await tools.find(tool => tool.name === 'bili_watch').execute({ link: bv }, context)).ok, true);
      assert.deepEqual(getMemoryStore(config).list(context), []);
    }
  } finally {
    globalThis.__config = originalConfig;
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('clearing memory during a Bilibili read prevents its late experience from reappearing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-forget-race-'));
  const originalConfig = globalThis.__config;
  const originalFetch = globalThis.fetch;
  globalThis.__config = {
    value: { 'alemonjs-agent-link': { runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } }
  };
  const config = getDSHConfig();
  let started, release;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  globalThis.fetch = async url => {
    if (String(url).endsWith('/nav')) return Response.json(nav);
    if (String(url).includes('/wbi/view')) {
      started();
      await gate;
      return ok({ bvid: bv, aid: 123, cid: 456, title: '旧视频' });
    }
    if (String(url).includes('/player/')) return ok({ subtitle: { subtitles: [] } });
    if (String(url).includes('/reply/')) return ok({ replies: [] });
    throw new Error('unexpected request');
  };
  try {
    const tools = [];
    biliModule(config).setup({ settings: { enabled: true }, tool: item => tools.push(item) });
    const context = { channelId: 'private:race', userId: '1', botId: '900', inputId: 'm1', platform: 'onebot', autonomous: false, signal: signal() };
    const pending = tools.find(tool => tool.name === 'bili_watch').execute({ link: bv }, context);
    await ready;
    getMemoryStore(config).clear(context, 0);
    release();
    assert.equal((await pending).ok, true);
    assert.deepEqual(getMemoryStore(config).list(context), []);
  } finally {
    release?.();
    globalThis.__config = originalConfig;
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('reading diary exposes only scoped Bilibili evidence and respects deletion and memory disable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-diary-'));
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } } };
  const config = getDSHConfig();
  const tools = [];
  biliModule(config).setup({ settings: {}, tool: tool => tools.push(tool) });
  const diary = tools.find(tool => tool.name === 'bili_diary');
  const context = { platform: 'onebot', channelId: 'private:test', botId: '900', signal: signal() };
  const store = getMemoryStore(config);
  try {
    assert.equal(diary.readOnly, true);
    store.recordExperience(context, { key: 'video-a', subjectId: '900', text: '真实阅读资料 A', tags: ['B站'] });
    store.recordExperience(context, { key: 'other-event', subjectId: '900', text: '其他活动', tags: ['其他'] });
    store.recordExperience({ ...context, channelId: 'other' }, { key: 'private-video', subjectId: '900', text: '别处的阅读', tags: ['B站'] });
    const result = await diary.execute({}, context);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].evidence, '真实阅读资料 A');
    assert.equal(result.entries[0].sourceEvidence[0].availability, 'available');
    assert.equal(result.entries[0].sourceEvidence[0].contentBasis, 'unknown');
    assert.equal((await diary.execute({ query: '资料 A' }, context)).entries.length, 1);
    assert.equal((await diary.execute({ query: '其他活动' }, context)).entries.length, 0);
    assert.equal((await diary.execute({ query: 'a'.repeat(81) }, context)).ok, false);
    assert.equal((await diary.execute({ hours: 169 }, context)).ok, false);
    assert.equal((await diary.execute({}, { ...context, botId: 'another' })).entries.length, 0);
    store.recordDiary(context, { key: 'thought-a', subjectId: '900', text: '{"thought":"续读问题"}', tags: ['B站'], sourceReadingId: result.entries[0].id });
    const thought = (await diary.execute({ query: '续读问题' }, context)).entries[0];
    assert.equal(thought.type, 'reflection');
    assert.equal(thought.sourceEvidence[0].id, result.entries[0].id);
    assert.equal(thought.sourceEvidence[0].availability, 'available');
    store.forget(context, result.entries[0].id, 0);
    assert.equal((await diary.execute({}, context)).entries.length, 0);
    globalThis.__config.value['alemonjs-agent-link'].modules = { disabled: ['memory'] };
    assert.equal((await diary.execute({}, context)).ok, false);
  } finally {
    store.close();
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('autonomous search excludes scoped recent reading while manual search and deleted memories remain available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-selection-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } } };
  const config = getDSHConfig();
  const tools = [];
  globalThis.fetch = async url =>
    String(url).endsWith('/nav')
      ? Response.json(nav)
      : ok({
          result: [
            { bvid: bv, title: '旧阅读' },
            { bvid: 'BVabcdefghij', title: '新候选' }
          ]
        });
  biliModule(config).setup({ settings: {}, tool: tool => tools.push(tool) });
  const search = tools.find(tool => tool.name === 'bili_search');
  const context = { platform: 'onebot', channelId: 'private:test', botId: '900', private: true, owner: true, autonomous: true, signal: signal() };
  const store = getMemoryStore(config);

  try {
    store.recordExperience(context, {
      key: 'read',
      subjectId: '900',
      text: `我读取了 B 站视频资料：${JSON.stringify({ bvid: bv })}。没有读取视频画面或声音。`,
      tags: ['B站']
    });
    const result = await search.execute({ keyword: '鲸鱼' }, { ...context });
    assert.deepEqual(
      result.items.map(item => item.bvid),
      ['BVabcdefghij']
    );
    assert.equal(result.excludedRecentlyRead, 1);
    globalThis.__config.value['alemonjs-agent-link'].modules = { settings: { bili: { dailyBrowseExclude: ['新候选'] } } };
    const filtered = await search.execute({ keyword: '鲸鱼' }, { ...context });
    assert.equal(filtered.items.length, 0);
    assert.equal(filtered.excludedRecentlyRead, 1);
    assert.equal(filtered.excludedByTopic, 1);
    assert.equal((await search.execute({ keyword: '鲸鱼' }, { ...context, autonomous: false })).items.length, 2);
    globalThis.__config.value['alemonjs-agent-link'].modules = {};

    assert.equal((await search.execute({ keyword: '鲸鱼' }, { ...context, autonomous: false })).items.length, 2);
    assert.equal((await search.execute({ keyword: '鲸鱼' }, { ...context, channelId: 'private:other' })).items.length, 2);
    const [entry] = store.list(context, { subjectId: '900' });
    store.forget(context, entry.id, 0);
    assert.equal((await search.execute({ keyword: '鲸鱼' }, { ...context })).items.length, 2);
    globalThis.__config.value['alemonjs-agent-link'].modules = { settings: { bili: { dailyBrowseTopics: ['新候选'] } } };
    const ranked = await search.execute({ keyword: '鲸鱼' }, { ...context });
    assert.deepEqual(
      ranked.items.map(item => item.bvid),
      ['BVabcdefghij', bv]
    );
    assert.deepEqual(ranked.items[0].matchedTopics, ['新候选']);
    const manual = await search.execute({ keyword: '鲸鱼' }, { ...context, autonomous: false });
    assert.deepEqual(
      manual.items.map(item => item.bvid),
      [bv, 'BVabcdefghij']
    );
  } finally {
    store.close();
    globalThis.fetch = oldFetch;
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('recent reading index ignores old, malformed and non-event memories', async () => {
  const { recentBiliIds } = await import('../lib/bili/experience.js');
  const now = 10 * 86400000;
  const valid = { status: 'active', origin: 'event', kind: 'event', tags: ['B站', bv], text: 'reading', createdAt: now };
  assert.deepEqual([...recentBiliIds([valid], now)], [bv]);
  for (const changed of [
    { status: 'outdated' },
    { origin: 'explicit' },
    { kind: 'fact' },
    { createdAt: now - 8 * 86400000 },
    { tags: ['B站'], text: '{broken' }
  ]) {
    assert.equal(recentBiliIds([{ ...valid, ...changed }], now).size, 0);
  }
});

test('autonomous candidate selection excludes confirmed shares even without reading memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-shared-'));
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  globalThis.__config = { value: { 'alemonjs-agent-link': { workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home') } } };
  const config = getDSHConfig();
  const scope = { platform: 'onebot', botId: '900', userId: '100' };
  const store = getProactiveStore(config);
  const options = proactiveOptions(config);
  store.subscribe(scope, true, options);
  const attempt = store.claim(scope, options, 1000, true);
  store.finish(attempt, 'confirmed', `推荐 ${bv}`);
  globalThis.fetch = async url =>
    String(url).endsWith('/nav')
      ? Response.json(nav)
      : ok({
          result: [
            { bvid: bv, title: '已分享' },
            { bvid: 'BVabcdefghij', title: '新内容' }
          ]
        });
  const tools = [];
  biliModule(config).setup({ settings: {}, tool: tool => tools.push(tool) });
  const search = tools.find(tool => tool.name === 'bili_search');
  const context = { ...scope, channelId: proactiveChannel(scope), private: true, owner: true, autonomous: true, signal: signal() };
  try {
    const result = await search.execute({ keyword: '鲸鱼' }, { ...context });
    assert.deepEqual(
      result.items.map(item => item.bvid),
      ['BVabcdefghij']
    );
    assert.equal(result.excludedAlreadyShared, 1);
    assert.equal(result.excludedRecentlyRead, 0);
    store.setBrowseFeedback(scope, '新内容', 'avoid');
    const feedbackFiltered = await search.execute({ keyword: '鲸鱼' }, { ...context });
    assert.equal(feedbackFiltered.items.length, 0);
    assert.equal(feedbackFiltered.excludedByTopic, 1);

    assert.equal((await search.execute({ keyword: '鲸鱼' }, { ...context, autonomous: false })).items.length, 2);
    const other = { ...context, userId: 'other', channelId: proactiveChannel({ ...scope, userId: 'other' }) };
    assert.equal((await search.execute({ keyword: '鲸鱼' }, other)).items.length, 2);
  } finally {
    store.close();
    globalThis.fetch = oldFetch;
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});
