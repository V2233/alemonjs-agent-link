import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { biliVisionSource, describeBiliFrames } from '../lib/bili/vision.js';
import { getMediaConfig } from '../lib/media/config.js';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { getCredentialPool } from '../lib/credentials/pool.js';
import { inspectBiliReadiness } from '../lib/panel/bili-diagnostics.js';
import { budgetedFetch, withBudgetScope } from '../lib/billing/budget.js';
import { createBiliClient } from '../lib/bili/client.js';

let previous, originalFetch, directory;
const media = () => getMediaConfig({});
const signal = () => new AbortController().signal;
const image = async () => ({
  seconds: 1,
  data: await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
});
const response = (finish = 'stop') =>
  Response.json({
    choices: [{ message: { content: '1秒可见红色方块。' }, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  });
const pool = () => getCredentialPool(getDSHConfig());
beforeEach(async () => {
  previous = globalThis.__config;
  originalFetch = globalThis.fetch;
  directory = await mkdtemp(join(tmpdir(), 'bili-vision-pool-'));
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        workspaceRoot: join(directory, 'work'),
        dshHomeRoot: join(directory, 'home'),
        budget: { enabled: false },
        modelPool: {
          probeIntervalSeconds: 0,
          endpoints: [
            { id: 'chat', apiKey: 'text-only-secret', baseUrl: 'https://chat.example/v1', model: 'text', capabilities: ['chat'] },
            { id: 'vision', apiKey: 'vision-secret', baseUrl: 'https://vision.example/v1', model: 'vision-model', capabilities: ['vision'], maxConcurrent: 1 }
          ]
        }
      }
    }
  };
});
afterEach(async () => {
  getCredentialPool({});
  globalThis.__config = previous;
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
});

test('vision preflight is pure and diagnostics recognize explicitly declared pool vision', async () => {
  assert.equal(biliVisionSource(media(), getDSHConfig()), 'model_pool');
  assert.ok(pool().status.every(row => row.active === 0 && row.totalCalls === 0));
  const report = await inspectBiliReadiness(getDSHConfig, media, async () => true);
  const check = report.checks.find(item => item.id === 'vision');
  assert.equal(check.state, 'ready');
  assert.match(check.detail, /模型池/);
  assert.ok(!/secret|https:/.test(JSON.stringify(report)));
});

test('pool vision uses the right endpoint, bounded payload, usage and capacity accounting', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://vision.example/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer vision-secret');
    assert.equal(pool().status.find(row => row.id === 'vision').active, 1);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'vision-model');
    assert.equal(body.max_tokens, 600);
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    return response();
  };
  assert.match(await describeBiliFrames([await image()], media(), signal()), /红色方块/);
  assert.equal(calls, 1);
  const state = pool().status.find(row => row.id === 'vision');
  assert.equal(state.active, 0);
  assert.equal(state.tokens, 120);
  assert.equal(state.successfulCalls, 1);
  assert.equal(state.purposeStatistics.vision.success, 1);
  assert.equal(pool().status.find(row => row.id === 'chat').totalCalls, 0);
});

test('explicit media provider takes priority without reserving the model pool', async () => {
  const settings = { ...media(), vision: { baseUrl: 'https://explicit.example', apiKey: 'independent', model: 'explicit-model' } };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://explicit.example/chat/completions');
    assert.equal(JSON.parse(init.body).model, 'explicit-model');
    return response();
  };
  assert.equal(biliVisionSource(settings, getDSHConfig()), 'explicit');
  await describeBiliFrames([await image()], settings, signal());
  assert.ok(pool().status.every(row => row.totalCalls === 0));
});

test('missing vision never falls back to a text endpoint or legacy key', async () => {
  const config = globalThis.__config.value['alemonjs-agent-link'];
  config.modelPool.endpoints.pop();
  config.apiKey = 'legacy-text-secret';
  globalThis.fetch = async () => {
    throw new Error('must not send');
  };
  assert.equal(biliVisionSource(media(), getDSHConfig()), undefined);
  await assert.rejects(describeBiliFrames([await image()], media(), signal()), /未配置/);
  assert.ok(pool().status.every(row => row.totalCalls === 0));
});

test('concurrency exhaustion, truncation, cancellation and malformed frames release pool slots', async () => {
  const frame = await image();
  const held = pool().select({ purpose: 'vision', reserve: true });
  globalThis.fetch = async () => {
    throw new Error('must not send when busy');
  };
  await assert.rejects(describeBiliFrames([frame], media(), signal()), /容量/);
  held.report({ ok: true });
  globalThis.fetch = async () => response('length');
  await assert.rejects(describeBiliFrames([frame], media(), signal()), /截断/);
  assert.equal(pool().status.find(row => row.id === 'vision').active, 0);
  await assert.rejects(describeBiliFrames([{ ...frame, seconds: -1 }], media(), signal()), /无效/);
  assert.equal(pool().status.find(row => row.id === 'vision').active, 0);
  const controller = new AbortController();
  globalThis.fetch = async () => {
    controller.abort();
    throw new Error('cancelled');
  };
  await assert.rejects(describeBiliFrames([frame], media(), controller.signal), { name: 'AbortError' });
  assert.equal(pool().status.find(row => row.id === 'vision').active, 0);
});

test('robot credentials do not bypass enabled budget admission and contradictory routing is rejected', async () => {
  globalThis.__config.value['alemonjs-agent-link'].budget.enabled = true;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return response();
  };
  await assert.rejects(describeBiliFrames([await image()], media(), signal()), /所属会话/);
  assert.equal(requests, 0);
  assert.equal(pool().status.find(row => row.id === 'vision').active, 0);
  await assert.rejects(budgetedFetch(getDSHConfig(), new URL('https://vision.example'), { robotKey: true, scopedKey: true }), /凭据类型冲突/);
});

test('robot routing never looks up a private bound key, even when that storage is unavailable', async () => {
  const config = getDSHConfig();
  const scope = { platform: 'test', channelId: 'private:vision-test', userId: 'vision-test' };
  globalThis.__config.value.db = {
    get redis() {
      throw new Error('bound credential lookup attempted');
    }
  };
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(String(url), 'https://vision.example/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer robot-fixture');
    return response();
  };
  const init = { method: 'POST', headers: { Authorization: 'Bearer robot-fixture' }, body: '{}' };
  await withBudgetScope(scope, () => budgetedFetch(config, new URL('https://vision.example/v1/chat/completions'), { ...init, robotKey: true }));
  assert.equal(requests, 1);
  await assert.rejects(
    withBudgetScope(scope, () => budgetedFetch(config, new URL('https://vision.example/v1/chat/completions'), init)),
    /bound credential lookup attempted/
  );
  assert.equal(requests, 1);
});

test('watch consumes pool vision without independent media settings and returns observation evidence', async () => {
  const frame = await image();
  const ok = data => Response.json({ code: 0, data });
  const fetcher = async url => {
    if (url.endsWith('/nav'))
      return ok({ wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } });
    if (url.includes('/wbi/view')) return ok({ bvid: 'BV1234567890', aid: 1, cid: 2, duration: 12 });
    if (url.includes('/playurl')) return ok({ durl: [{ url: 'https://v.bilivideo.com/test.mp4' }] });
    return ok({});
  };
  let downloaded = 0;
  globalThis.fetch = async () => response();
  const client = createBiliClient(
    { visualRead: true, cookie: '', timeoutMs: 5000 },
    fetcher,
    async () => {
      downloaded++;
      assert.ok(pool().status.every(row => row.active === 0));
      return Buffer.from('decoded by fixture');
    },
    { extract: async () => [frame], extractSubtitles: async () => [], describe: describeBiliFrames }
  );
  const result = await client.watch('BV1234567890', signal());
  assert.equal(downloaded, 1);
  assert.equal(result.visual.status, 'available');
  assert.equal(result.evidence.visualObserved, true);
  assert.equal(result.evidence.audioObserved, false);
  assert.deepEqual(result.evidence.sampledTimestamps, [1]);
  assert.equal(pool().status.find(row => row.id === 'vision').active, 0);
});

test('vision endpoints sharing one account cannot each spend the same pending TPM capacity', () => {
  const endpoints = globalThis.__config.value['alemonjs-agent-link'].modelPool.endpoints;
  const vision = endpoints.find(endpoint => endpoint.id === 'vision');
  vision.account = 'vision-account';
  vision.tpm = 10000;
  endpoints.push({ ...vision, id: 'vision-second', apiKey: 'second-vision-secret' });
  const selectedPool = pool();
  const first = selectedPool.select({ purpose: 'vision', reserve: true, estimatedTokens: 8192 });
  assert.ok(first);
  assert.equal(selectedPool.select({ purpose: 'vision', reserve: true, estimatedTokens: 8192 }), null);
  first.report({ ok: false, errorKind: 'cancelled' });
  const afterRelease = selectedPool.select({ purpose: 'vision', reserve: true, estimatedTokens: 8192 });
  assert.ok(afterRelease);
  afterRelease.report({ ok: false, errorKind: 'cancelled' });
  assert.ok(selectedPool.status.every(row => row.active === 0));
});
