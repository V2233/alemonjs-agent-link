import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfig } from 'alemonjs';
import { getDSHConfig } from '../lib/dsh/client.js';
import { DiaryWorker, diaryOptions } from '../lib/qzone/diary.js';
import { OneBotActions } from '../lib/onebot/actions.js';
import { getChatArchive } from '../lib/history/store.js';
import { proactiveChannel } from '../lib/proactive/control.js';
import { qzoneModule } from '../lib/modules/qzone.js';

const time = Date.parse('2026-10-28T12:00:00Z');
const qzone = { enabled: true, allowPost: true, dryRun: true, cooldownSeconds: 0, visibility: 'friends', diary: { enabled: true, ownerId: '100', botId: '900', hour: 20, timezone: 'Asia/Shanghai' } };
const configFor = (root, settings = qzone) => getDSHConfig({ stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), modules: { settings: { qzone: settings } } });
const servicesFor = (config, extra = {}) => ({ config: () => config, now: () => time, owner: id => id === '100', online: async () => true,
  history: () => [{ role: 'user', text: '今天聊了喜欢的书', timestamp: time - 60000 }], generate: async () => '今天聊到了喜欢的书。', ...extra });

test('scheduled preview is durable and prevents repeated generation on the same day', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qzone-diary-preview-'));
  const config = configFor(root);
  let generates = 0, posts = 0;
  const services = servicesFor(config, { generate: async (_config, prompt) => { generates++; assert.match(prompt, /喜欢的书/); return '聊书的一天。'; }, post: async () => { posts++; } });
  const worker = new DiaryWorker(config, services);
  try {
    await Promise.all([worker.tick(), worker.tick()]);
    assert.equal(generates, 1);
    assert.equal(posts, 0);
    assert.equal(worker.status().latest.state, 'preview');
    assert.equal(worker.status().latest.content, '聊书的一天。');
    worker.close();
    const restarted = new DiaryWorker(config, services);
    await restarted.tick();
    assert.equal(generates, 1);
    assert.equal(restarted.status().latest.state, 'preview');
    restarted.close();
  } finally { worker.close(); await rm(root, { recursive: true, force: true }); }
});

test('scheduled live post crosses OneBot bridge once and records confirmed receipt', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'qzone-diary-send-'));
  const settings = { ...qzone, dryRun: false };
  const config = configFor(root, settings);
  const calls = [];
  const adapter = new OneBotActions({ config: { selfId: '900' }, call: async (action, args) => {
    calls.push({ action, args }); return { tid: 'post-id' };
  } }, () => ({ owner: id => id === '100', groups: [], disabled: [], qzone: settings }));
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now, api: frame => adapter.api(frame) };
  const first = new DiaryWorker(config, servicesFor(config));
  const second = new DiaryWorker(config, servicesFor(config));
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': { stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), modules: { settings: { qzone: settings } } } });
      await Promise.all([first.tick(), second.tick()]);
      assert.deepEqual(calls, [{ action: 'send_qzone_msg', args: { content: '今天聊到了喜欢的书。', ugc_right: 4 } }]);
      assert.equal(first.status().latest.state, 'confirmed');
      await second.tick();
      assert.equal(calls.length, 1);
    });
  } finally { first.close(); second.close(); await rm(root, { recursive: true, force: true }); }
});

test('disabled, empty, owner revoked, changed policy and uncertain receipt do not silently retry', async () => {
  for (const mode of ['empty', 'owner', 'changed', 'unknown']) {
    const root = await mkdtemp(join(tmpdir(), 'qzone-diary-gate-'));
    const config = configFor(root, { ...qzone, dryRun: false });
    let current = config, posts = 0, generations = 0;
    const services = servicesFor(config, { config: () => current, owner: () => mode !== 'owner', history: () => mode === 'empty' ? [] : [{ role: 'user', text: '聊天', timestamp: time }],
      generate: async () => { generations++; if (mode === 'changed') current = configFor(root, { ...qzone, dryRun: true }); return '日记'; },
      post: async () => { posts++; throw new Error('reply lost'); } });
    const worker = new DiaryWorker(config, services);
    try {
      await worker.tick();
      const latest = worker.status().latest;
      assert.equal(latest?.state ?? null, mode === 'owner' ? null : mode === 'empty' ? 'skipped' : mode === 'changed' ? 'preview' : 'unknown');
      await worker.tick();
      assert.equal(posts, mode === 'unknown' ? 1 : 0);
      assert.equal(generations, mode === 'empty' || mode === 'owner' ? 0 : 1);
    } finally { worker.close(); await rm(root, { recursive: true, force: true }); }
  }
  assert.throws(() => diaryOptions({ diary: { enabled: true, botId: 'x', ownerId: '1' } }));
});

test('actual daily archive feeds the configured model, then persists a preview', async () => {
  const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
  const root = await mkdtemp(join(tmpdir(), 'qzone-diary-model-'));
  const settings = { ...qzone, diary: { ...qzone.diary, hour: 0 } };
  const config = configFor(root, settings);
  const oldFetch = globalThis.fetch;
  const channelId = proactiveChannel({ platform: 'onebot', botId: '900', userId: '100' });
  const now = Date.now();
  const archive = getChatArchive(config);
  archive.append({ platform: 'onebot', channelId }, { id: 'm1', speakerId: '100', speaker: '主人', role: 'user', text: '讨论了白鲸', timestamp: now });
  archive.append({ platform: 'onebot', channelId: 'different' }, { id: 'm2', speakerId: '101', speaker: '他人', role: 'user', text: '无关私聊秘密', timestamp: now });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const text = JSON.stringify(body.messages);
    assert.match(text, /讨论了白鲸/);
    assert.doesNotMatch(text, /无关私聊秘密/);
    calls++;
    return Response.json({ choices: [{ message: { content: '今天聊到了白鲸。' } }] });
  };
  const runtime = { resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now };
  const worker = new DiaryWorker(config, { config: () => config, now: () => now, owner: () => true, online: async () => true });
  try {
    await runtimeScope.run(runtime, async () => {
      getConfig().saveValue({ 'alemonjs-agent-link': { apiKey: 'test', model: 'test', stateBackend: 'local', workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), modules: { settings: { qzone: settings } } } });
      await worker.tick();
      assert.equal(calls, 1);
      assert.equal(worker.status().latest.state, 'preview');
      assert.equal(worker.status().latest.content, '今天聊到了白鲸。');
    });
  } finally { worker.close(); globalThis.fetch = oldFetch; await rm(root, { recursive: true, force: true }); }
});

test('module status respects configured owner and uses refreshed module settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qzone-diary-module-'));
  const config = configFor(root, {});
  const tools = [], dispose = [];
  try {
    qzoneModule(config).setup({ settings: qzone, tool: tool => tools.push(tool), onDispose: fn => dispose.push(fn) });
    const status = tools.find(tool => tool.name === 'qzone_diary_status');
    const context = { platform: 'onebot', private: true, owner: true, userId: '100', botId: '900', autonomous: false };
    assert.equal(status.available(context), true);
    assert.equal((await status.execute({}, context)).ok, true);
    assert.equal((await status.execute({}, { ...context, userId: '101' })).ok, false);
    assert.equal(status.available({ ...context, autonomous: true }), false);
  } finally { for (const fn of dispose) await fn(); await rm(root, { recursive: true, force: true }); }
});

test('stopping a running generation prevents publishing and persists cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qzone-diary-stop-'));
  const config = configFor(root, { ...qzone, dryRun: false });
  let ready, release, posts = 0;
  const started = new Promise(resolve => { ready = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const worker = new DiaryWorker(config, servicesFor(config, { generate: async () => { ready(); await pending; return '日记'; }, post: async () => { posts++; } }));
  try {
    const run = worker.tick();
    await started;
    worker.stop();
    release();
    await run;
    assert.equal(posts, 0);
    const restarted = new DiaryWorker(config, servicesFor(config));
    assert.equal(restarted.status().latest.state, 'cancelled');
    await restarted.tick();
    assert.equal(restarted.status().latest.state, 'cancelled');
    restarted.stop();
  } finally { worker.stop(); await rm(root, { recursive: true, force: true }); }
});
