import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseDaily } from '../lib/proactive/browse.js';
import { proactiveChannel } from '../lib/proactive/control.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { getMemoryStore } from '../lib/memory/store.js';

for (const scenario of ['reading', 'silence', 'cancelled', 'comparison']) {
  test(`independent daily browser runs real tools with ${scenario} outcome`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'daily-browse-'));
    const previous = globalThis.__config;
    const oldFetch = globalThis.fetch;
    const controller = new AbortController();
    const scope = { platform: 'onebot', userId: '100', botId: '900' };
    globalThis.__config = {
      value: {
        'alemonjs-agent-link': {
          apiKey: 'test',
          model: 'test',
          runtimeMode: 'chat-only',
          stateBackend: 'local',
          workspaceRoot: join(root, 'work'),
          dshHomeRoot: join(root, 'home'),
          modules: { disabled: ['opinions'], settings: { bili: { dailyBrowse: true, dailyBrowseTopics: ['海洋生态'], dailyBrowseExclude: ['恐怖'] } } }
        }
      }
    };
    const config = getDSHConfig();
    const bv = 'BV1234567890';
    let calls = 0;
    const ok = data => Response.json({ code: 0, data });
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address.endsWith('/nav'))
        return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
      if (address.includes('/search/type'))
        return ok({ result: [{ bvid: bv, title: '鲸鱼歌声' }, ...(scenario === 'comparison' ? [{ bvid: 'BVabcdefghij', title: '另一份鲸鱼资料' }] : [])] });
      if (address.includes('/wbi/view')) {
        if (scenario === 'cancelled') controller.abort();
        return ok({ bvid: new URL(address).searchParams.get('bvid') || bv, aid: 123, cid: 456, title: '鲸鱼歌声', desc: '研究鲸鱼歌声的资料' });
      }
      if (address.includes('/player/')) return ok({ subtitle: { subtitles: [] } });
      if (address.includes('/reply/')) return ok({ replies: [] });
      assert.ok(address.includes('/chat/completions'), `unexpected network destination: ${address}`);
      const request = JSON.parse(init.body);
      assert.match(JSON.stringify(request.messages), /海洋生态/);
      assert.match(JSON.stringify(request.messages), /priorThoughts/);
      if (scenario === 'reading') assert.match(JSON.stringify(request.messages), /还不清楚鲸鱼如何交流/);
      assert.match(JSON.stringify(request.messages), /恐怖/);
      assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), ['bili_diary', 'bili_search', 'bili_watch']);
      calls++;
      const step = [
        ['bili_diary', {}],
        ['bili_search', { keyword: '鲸鱼' }],
        ['bili_watch', { link: bv }]
      ][calls - 1];
      if (scenario === 'comparison' && calls === 3)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [bv, 'BVabcdefghij', 'BV0987654321'].map((link, n) => ({
                  id: `multi-${n}`,
                  type: 'function',
                  function: { name: 'bili_watch', arguments: JSON.stringify({ link }) }
                }))
              }
            }
          ]
        });
      if (step)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: `step-${calls}`, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }]
              }
            }
          ]
        });
      assert.match(JSON.stringify(request.messages), /研究鲸鱼歌声的资料/);
      const toolResults = request.messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
      if (scenario === 'comparison') {
        assert.equal(toolResults.filter(item => item.video).length, 2);
        assert.equal(toolResults.at(-1).ok, false);
      }
      const reading = toolResults.find(item => item.video);
      assert.equal(reading.evidence.basis, 'metadata');
      assert.equal(reading.evidence.visualObserved, false);
      return Response.json({ choices: [{ message: { content: scenario === 'silence' ? '[沉默]|||' : '鲸鱼歌声这个主题很有趣。|||我想继续了解。' } }] });
    };
    try {
      if (scenario === 'reading')
        getMemoryStore(config).recordDiary(
          { platform: scope.platform, botId: scope.botId, channelId: proactiveChannel(scope) },
          {
            key: 'previous-thought',
            subjectId: scope.botId,
            tags: ['B站', '阅读感想'],
            text: '想法：{"title":"海洋生态","thought":"还不清楚鲸鱼如何交流"}'
          }
        );
      if (scenario === 'cancelled') await assert.rejects(() => browseDaily(config, scope, controller.signal));
      else assert.equal(await browseDaily(config, scope, controller.signal), 'recorded');
      const entries = getMemoryStore(config).list(
        { platform: scope.platform, botId: scope.botId, channelId: proactiveChannel(scope) },
        { subjectId: scope.botId }
      );
      assert.equal(entries.filter(item => item.origin === 'event').length, scenario === 'cancelled' ? 0 : scenario === 'comparison' ? 2 : 1);
      assert.equal(entries.filter(item => item.origin === 'diary').length, scenario === 'reading' ? 2 : scenario === 'comparison' ? 1 : 0);
      if (scenario === 'reading') assert.ok(entries.some(item => item.origin === 'diary' && item.text.includes('想继续了解')));
      assert.ok(entries.filter(item => item.origin === 'diary').every(item => !item.text.includes('|||')));
      if (scenario === 'comparison') {
        const thought = entries.find(item => item.origin === 'diary');
        assert.equal(thought.tags.filter(tag => tag.startsWith('reading:')).length, 2);
        assert.match(thought.text, /BVabcdefghij/);
        assert.ok(!thought.text.includes('BV0987654321'));
      }
      assert.deepEqual(getMemoryStore(config).list({ platform: scope.platform, botId: scope.botId, channelId: 'other' }), []);
    } finally {
      await (await getModuleRuntime(config)).close();
      globalThis.fetch = oldFetch;
      globalThis.__config = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of ['final-thought', 'final-unavailable', 'no-reading', 'configured-tighter']) {
  test(`independent browser bounds model loops and finalizes with ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'browse-round-limit-'));
    const previous = globalThis.__config;
    const oldFetch = globalThis.fetch;
    const scope = { platform: 'onebot', userId: '100', botId: '900' };
    globalThis.__config = {
      value: {
        'alemonjs-agent-link': {
          apiKey: 'test',
          model: 'test',
          runtimeMode: 'chat-only',
          stateBackend: 'local',
          workspaceRoot: join(root, 'work'),
          dshHomeRoot: join(root, 'home'),
          modules: {
            disabled: ['opinions'],
            maxToolRounds: scenario === 'configured-tighter' ? 2 : 16,
            maxToolContinuations: 4,
            settings: { bili: { dailyBrowse: true, dailyBrowseMaxReads: 1 } }
          }
        }
      }
    };
    const config = getDSHConfig();
    let calls = 0;
    let summaries = 0;
    let videoReads = 0;
    const ok = data => Response.json({ code: 0, data });
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address.endsWith('/nav'))
        return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
      if (address.includes('/search/type')) return ok({ result: [{ bvid: 'BV1234567890', title: '鲸鱼歌声' }] });
      if (address.includes('/wbi/view')) {
        videoReads++;
        return ok({ bvid: 'BV1234567890', aid: 123, cid: 456, title: '鲸鱼歌声', desc: '研究鲸鱼歌声的资料' });
      }
      if (address.includes('/player/')) return ok({ subtitle: { subtitles: [] } });
      if (address.includes('/reply/')) return ok({ replies: [] });
      assert.ok(address.includes('/chat/completions'));
      const request = JSON.parse(init.body);
      calls++;
      assert.ok(calls <= 5, 'reading must not enter configured chat continuations');
      if (!request.tools?.length) {
        summaries++;
        assert.match(request.messages.at(-1).content, /独立阅读的模型轮次已用完/);
        assert.match(request.messages.at(-1).content, /不向用户发消息/);
        if (scenario === 'final-unavailable') return Response.json({ error: { message: 'test unavailable' } }, { status: 401 });
        return Response.json({ choices: [{ message: { content: scenario === 'final-thought' ? '歌声交流这个主题值得继续了解。' : '[沉默]' } }] });
      }
      const sequence = [
        ['bili_diary', {}],
        ['bili_search', { keyword: '鲸鱼' }],
        ['bili_watch', { link: 'BV1234567890' }]
      ];
      const [name, args] = scenario === 'no-reading' ? sequence[0] : sequence[Math.min(calls - 1, 2)];
      return Response.json({
        choices: [{ message: { content: null, tool_calls: [{ id: `step-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }]
      });
    };
    try {
      const read = scenario === 'final-thought' || scenario === 'final-unavailable';
      assert.equal(await browseDaily(config, scope, AbortSignal.timeout(10000)), read ? 'recorded' : 'completed');
      assert.equal(calls, scenario === 'configured-tighter' ? 3 : 5);
      assert.equal(summaries, 1);
      assert.equal(videoReads, read ? 1 : 0);
      const entries = getMemoryStore(config).list(
        { platform: scope.platform, botId: scope.botId, channelId: proactiveChannel(scope) },
        { subjectId: scope.botId }
      );
      const diaries = entries.filter(item => item.origin === 'diary');
      assert.equal(diaries.length, scenario === 'final-thought' ? 1 : 0);
      assert.ok(diaries.every(item => !/工具次数|份回执|请缩小/.test(item.text)));
      assert.equal(config.modules.maxToolRounds, scenario === 'configured-tighter' ? 2 : 16);
      assert.equal(config.modules.maxToolContinuations, 4);
    } finally {
      await (await getModuleRuntime(config)).close();
      getMemoryStore(config).close();
      globalThis.fetch = oldFetch;
      globalThis.__config = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}
