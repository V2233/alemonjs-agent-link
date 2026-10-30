import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseDaily } from '../lib/proactive/browse.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { getChatCredentials } from '../lib/dsh/credentials.js';
import { CredentialPool, getCredentialPool } from '../lib/credentials/pool.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { getMemoryStore } from '../lib/memory/store.js';
import { getProactiveStore } from '../lib/proactive/store.js';
import { estimateModelRequestTokens } from '../lib/agent/token-estimate.js';
import { runToolChat } from '../lib/agent/tool-chat.js';
import { parseModelPool } from '../lib/model-pool/config.js';

for (const scenario of ['normal', 'rpm', 'tpm', 'second-request-contention']) {
  test(`independent reading reserves each model request with ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'reading-pool-'));
    const previous = globalThis.__config;
    const oldFetch = globalThis.fetch;
    globalThis.__config = { value: { onebot: {master_id:['100']}, 'alemonjs-agent-link': {
      model: 'fixture', runtimeMode: 'chat-only', stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'),
      modules: { disabled: ['opinions'], settings: { bili: { dailyBrowse: true, dailyBrowseMaxReads: 1 } } },
      modelPool: { queueMaxWaitMs: 0, probeIntervalSeconds: 0, endpoints: [{ id: 'only', apiKey: 'fixture-key', baseUrl: 'https://model.example/v1', model: 'fixture',
        capabilities: ['chat', 'tools'], maxConcurrent: 1, rpm: scenario === 'rpm' ? 2 : 20, tpm: scenario === 'tpm' ? 5000 : 200000 }] }
    } } };
    const config = getDSHConfig();
    const pool = getCredentialPool(config);
    let calls = 0;
    const ok = data => Response.json({ code: 0, data });
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (address.endsWith('/nav')) return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
      if (address.includes('/search/type')) return ok({ result: [{ bvid: 'BV1234567890', title: '鲸鱼歌声' }] });
      if (address.includes('/wbi/view')) return ok({ bvid: 'BV1234567890', aid: 123, cid: 456, title: '鲸鱼歌声', desc: '合成资料' });
      if (address.includes('/player/')) return ok({ subtitle: { subtitles: [] } });
      if (address.includes('/reply/')) return ok({ replies: [] });
      assert.equal(address, 'https://model.example/v1/chat/completions');
      const request = JSON.parse(init.body);
      calls++;
      assert.equal(pool.status[0].active, 1, 'every round must have its own live reservation');
      assert.equal(pool.status[0].totalCalls, calls);
      if (calls === 2 && scenario === 'second-request-contention') {
        assert.equal(await getChatCredentials({ purpose: 'tools', estimatedTokens: 100 }), null, 'another request must not bypass the second-round occupancy');
      }
      assert.ok(estimateModelRequestTokens(request.messages, []) > 5000, 'full persona is included');
      const steps = [['bili_diary', {}], ['bili_search', { keyword: '鲸鱼' }], ['bili_watch', { link: 'BV1234567890' }]];
      const step = steps[calls - 1];
      return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ message: step
        ? { content: null, tool_calls: [{ id: `step-${calls}`, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
        : { content: '这个主题值得继续了解。' } }] });
    };
    try {
      const run = () => browseDaily(config, { platform: 'onebot', userId: '100', botId: '900' }, AbortSignal.timeout(10000));
      if (scenario === 'rpm' || scenario === 'tpm') await assert.rejects(run, /凭证|额度|绑定端点暂不可用/);
      else assert.equal(await run(), 'recorded');
      assert.equal(calls, scenario === 'tpm' ? 0 : scenario === 'rpm' ? 2 : 4);
      const status = pool.status[0];
      assert.equal(status.totalCalls, calls);
      assert.equal(status.requests, calls);
      assert.equal(status.successfulCalls, calls);
      assert.equal(status.tokens, calls * 110);
      assert.equal(status.active, 0);
      assert.equal(status.lifecycle.sent, calls);
    } finally {
      await (await getModuleRuntime(config)).close();
      getMemoryStore(config).close();
      getProactiveStore(config).close();
      getCredentialPool({});
      globalThis.fetch = oldFetch;
      globalThis.__config = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('admission estimate includes tool schema, history, receipts and each image without tokenizing base64', () => {
  const base = [{ role: 'system', content: '人格'.repeat(1000) }, { role: 'user', content: '阅读' }];
  const tool = { name: 'read', description: '用途'.repeat(200), parameters: { type: 'object', properties: {} } };
  const initial = estimateModelRequestTokens(base, [tool]);
  assert.ok(initial > estimateModelRequestTokens(base, []));
  assert.ok(estimateModelRequestTokens([...base, { role: 'tool', content: '实际资料'.repeat(500) }], [tool]) > initial);
  const image = url => [...base, { role: 'user', content: [{ type: 'image_url', image_url: { url } }] }];
  assert.equal(estimateModelRequestTokens(image('data:image/png;base64,' + 'a'.repeat(100000)), []), estimateModelRequestTokens(image('https://images.example/1'), []));
  assert.ok(estimateModelRequestTokens(image('https://images.example/1'), []) >= estimateModelRequestTokens(base, []) + 6000);
  assert.equal(estimateModelRequestTokens(base, [], 100) - estimateModelRequestTokens(base, [], 50), 50);
});

for (const scenario of ['oversized-before-send', 'cancelled-after-acquire']) {
  test(`factory-acquired pool capacity is released when ${scenario}`, async () => {
    const pool = new CredentialPool(parseModelPool({ endpoints: [{ id: 'one', apiKey: 'fixture-key', maxConcurrent: 1 }] }, { provider: 'test', baseUrl: 'https://model.example/v1', model: 'fixture' }));
    const controller = new AbortController();
    const original = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = async () => { sends++; throw new Error('must not send'); };
    try {
      await assert.rejects(() => runToolChat({
        config: { model: 'fixture', provider: 'test', defaultSystemPrompt: '人格', maxRequestBytes: scenario === 'oversized-before-send' ? 1 : 100000, inputBlockedKeywords: [], outputBlockedKeywords: [] },
        credentials: async () => {
          const lease = pool.select({ reserve: true });
          if (scenario === 'cancelled-after-acquire') controller.abort();
          return lease;
        },
        input: '阅读', tools: [], maxRounds: 1, maxContinuations: 0,
        context: { platform: 'onebot', channelId: 'private:fixture', userId: '1', private: true, owner: true, userText: '', capabilities: { chat: true, web: false, files: false, terminal: false }, signal: controller.signal }
      }));
      assert.equal(sends, 0);
      assert.equal(pool.status[0].active, 0);
      assert.equal(pool.status[0].lifecycle.sent, 0);
      assert.equal(pool.status[0].lifecycle.records[0].reason, scenario === 'cancelled-after-acquire' ? 'cancelled' : 'invalid-response');
      const next = pool.select({ reserve: true });
      assert.ok(next);
      next.report({ ok: true });
    } finally {
      globalThis.fetch = original;
      pool.stop();
    }
  });
}
