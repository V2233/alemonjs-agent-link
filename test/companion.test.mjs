import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PersonaStore, getPersonaStore } from '../lib/companion/personas.js';
import { MoodStore, keywordMoodDelta, moodOptions } from '../lib/companion/mood.js';
import {
  automaticVoiceText,
  hasStickerIntent,
  needsTextSupplement,
  planExpression,
  selectExpressionSticker,
  moodGroupPolicy,
  expressionOptions
} from '../lib/companion/expression.js';
import { getDSHConfig } from '../lib/dsh/client.js';
import { ModuleRuntime, getModuleRuntime } from '../lib/agent/modules.js';
import { moodModule } from '../lib/modules/mood.js';
import { runCoordinatedChat, resetGroupSession } from '../lib/dsh/orchestrator.js';
import { runModuleTurn } from '../lib/agent/turn.js';
import { SessionRegistry } from '../lib/state/registry.js';

const scope = { platform: 'qq', channelId: 'private:one' };
const other = { ...scope, channelId: 'private:two' };
const options = { baseline: 60, halfLifeHours: 6, modelJudge: false };
const definition = { id: 'tea', name: '茶友', prompt: '用温和简短的中文回应。', privateRules: '主人私聊规则', socialRules: '社交规则', tags: ['茶'] };
const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'companion-'));
  const original = globalThis.__config;
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
        modules: { settings: { memory: { automatic: false }, mood: { modelJudge: false } } }
      }
    }
  };
  const config = getDSHConfig();
  try {
    await run({ root, config });
  } finally {
    await (await getModuleRuntime(config)).close();
    globalThis.__config = original;
    globalThis.fetch = oldFetch;
    await rm(root, { recursive: true, force: true });
  }
};
const context = (changes = {}) => ({
  ...scope,
  requestId: 'r',
  inputId: 'm',
  userId: 'one',
  private: true,
  owner: true,
  userText: '谢谢你！',
  capabilities: { chat: true, web: false, files: false, terminal: false },
  signal: new AbortController().signal,
  ...changes
});

test('persona files persist choices, preserve configured defaults and layer owner rules without changing permissions', () =>
  fixture(async ({ root, config }) => {
    let store = new PersonaStore(join(root, 'store'));
    try {
      await store.save(definition);
      await store.select(scope, 'tea');
      assert.equal((await stat(join(store.directory, 'tea.json'))).mode & 0o777, 0o600);
      assert.equal(store.selected(other), undefined);
      assert.equal(store.selected({ ...scope, platform: 'discord' }), undefined);
      const owner = await store.systemPrompt(config, { ...scope, private: true, owner: true });
      assert.match(owner, /主人私聊规则/u);
      assert.doesNotMatch(owner, /社交规则/u);
      for (const flags of [
        { private: true, owner: false },
        { private: false, owner: true }
      ]) {
        assert.match(await store.systemPrompt(config, { ...scope, ...flags }), /社交规则/u);
      }
      assert.ok(
        (await store.systemPrompt({ ...config, defaultSystemPrompt: '配置自定义' }, { ...other, private: true, owner: true })).startsWith('配置自定义')
      );
      await assert.rejects(store.remove('tea'), /先将/u);
      store.close();
      store = new PersonaStore(join(root, 'store'));
      assert.equal(store.selected(scope), 'tea');
      await store.select(scope);
      await store.remove('tea');
      assert.equal((await store.read('assistant')).id, 'assistant');
      await store.save({ id: 'assistant', name: '自定义助手', prompt: '新提示' });
      await store.remove('assistant');
      assert.equal((await store.read('assistant')).name, '通用助手');
    } finally {
      store.close();
    }
  }));

test('persona rejects traversal, links, mismatching ids and invalid selected files rather than silently changing character', () =>
  fixture(async ({ root, config }) => {
    const store = new PersonaStore(join(root, 'store'));
    try {
      await assert.rejects(store.read('../secret'));
      await assert.rejects(store.save({ ...definition, prompt: 'x'.repeat(12001) }));
      await writeFile(join(root, 'outside.json'), JSON.stringify(definition));
      await symlink(join(root, 'outside.json'), join(store.directory, 'tea.json'));
      await assert.rejects(store.read('tea'));
      await assert.rejects(store.save(definition));
      await rm(join(store.directory, 'tea.json'));
      await store.save(definition);
      await store.select(scope, 'tea');
      await writeFile(join(store.directory, 'tea.json'), JSON.stringify({ ...definition, id: 'other' }));
      await assert.rejects(store.systemPrompt(config, { ...scope, private: true, owner: true }));
      assert.equal((await store.list()).find(row => row.id === 'tea').error, '文件无效');
      store.purgeHash(createHash('sha256').update(scope.channelId).digest('hex'));
      assert.equal(store.selected(scope), undefined);
    } finally {
      store.close();
    }
  }));

test('a selected persona reaches the actual model system message and switching resets the conversation generation', () =>
  fixture(async ({ config }) => {
    const personas = getPersonaStore(config);
    await personas.save(definition);
    await personas.select(scope, 'tea');
    let called = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.match(body.messages[0].content, /用温和简短的中文回应。/u);
      assert.match(body.messages[0].content, /主人私聊规则/u);
      assert.doesNotMatch(body.messages[0].content, /社交规则/u);
      assert.equal(
        body.tools.some(tool => tool.function.name === 'agent_workspace'),
        false
      );
      called++;
      return Response.json({ choices: [{ message: { content: '好呀' } }] });
    };
    let answer = '';
    await runModuleTurn({
      config,
      sessionId: 'persona',
      input: '喝茶吗',
      context: context(),
      onEvent: async event => {
        if (event.type === 'content') answer += event.content;
      }
    });
    assert.equal(answer, '好呀');
    assert.equal(called, 1);
    const registry = new SessionRegistry(config);
    const before = await registry.meta(scope.channelId);
    await resetGroupSession(scope.channelId, config, () => personas.select(scope, 'assistant'));
    assert.equal((await registry.meta(scope.channelId)).generation, before.generation + 1);
    assert.equal(personas.selected(scope), 'assistant');
  }));

test('mood restores after restart, decays toward baseline, isolates scopes and bounds history', () =>
  fixture(async ({ root }) => {
    let now = 100000;
    let store = new MoodStore(join(root, 'store'), () => now);
    try {
      store.observe(scope, 'one', -6, options);
      assert.equal(store.snapshot(scope, options).value, 54);
      assert.equal(store.snapshot(other, options).value, 60);
      store.close();
      store = new MoodStore(join(root, 'store'), () => now);
      assert.equal(store.snapshot(scope, options).value, 54);
      now += 6 * 3600000;
      assert.equal(store.snapshot(scope, options).value, 57);
      for (let i = 0; i < 30; i++) {
        now += 10001;
        store.observe(scope, `input-${i}`, -6, options);
      }
      assert.ok(store.snapshot(scope, options).value >= 0);
      assert.equal(store.history(scope).length, 20);
      now += 31 * 86400000;
      assert.equal(store.snapshot(scope, options, 30).value, 60);
      assert.deepEqual(store.history(scope), []);
    } finally {
      store.close();
    }
  }));

test('mood source deduplication, burst limits, stale model guards and purge prevent old judgments from returning', () =>
  fixture(async ({ root }) => {
    let now = 100000;
    const store = new MoodStore(join(root, 'store'), () => now);
    try {
      const first = store.observe(scope, 'one', 4, options);
      assert.equal(first.value, 64);
      const duplicate = store.observe(scope, 'one', 4, options);
      assert.equal(duplicate.value, 64);
      assert.equal(duplicate.token, undefined);
      assert.equal(store.applyModel(scope, first.token, 2, options), true);
      assert.equal(store.snapshot(scope, options).value, 62);
      assert.equal(store.applyModel(scope, first.token, 6, options), false);
      const burst = store.observe(scope, 'two', 4, options);
      assert.equal(burst.value, 62);
      now += 10001;
      const fresh = store.observe(scope, 'three', -6, options);
      assert.equal(store.applyModel(scope, burst.token, 6, options), false);
      store.purgeHash(createHash('sha256').update(scope.channelId).digest('hex'));
      const after = store.observe(scope, 'new', 0, options);
      assert.notEqual(after.token, fresh.token);
      assert.equal(store.applyModel(scope, fresh.token, 6, options), false);
      assert.equal(store.snapshot(scope, options).value, 60);
      assert.deepEqual(store.history(scope), []);
    } finally {
      store.close();
    }
  }));

test('mood keyword rules do not punish user distress, quotations, negations or command text', () => {
  assert.equal(keywordMoodDelta('你真棒！'), 4);
  assert.equal(keywordMoodDelta('你这个废物'), -6);
  for (const text of ['我很难过', '我是废物', '他说你这个废物', '你不是笨蛋', '“你这个废物”', '/chat 你这个废物', '为什么难过？'])
    assert.equal(keywordMoodDelta(text), 0);
  assert.throws(() => moodOptions({ modules: { settings: { mood: { baseline: 101 } } } }));
});

test('ordinary mood stays out of the prompt while an expressive mood gently changes tone', () =>
  fixture(async ({ config }) => {
    const neutral = new ModuleRuntime(config, [moodModule(config)]);
    const upbeatConfig = { ...config, modules: { settings: { mood: { baseline: 80 } } } };
    const upbeat = new ModuleRuntime(upbeatConfig, [moodModule(upbeatConfig)]);
    const a = await neutral.acquire();
    const b = await upbeat.acquire();
    try {
      assert.equal(await a.context(context({ channelId: 'neutral', inputId: 'a', userText: '你好' })), '');
      const prompt = await b.context(context({ channelId: 'upbeat', inputId: 'b', userText: '你好' }));
      assert.match(prompt, /轻快/);
      assert.doesNotMatch(prompt, /100|心情值/);
    } finally {
      await a.release();
      await b.release();
      await neutral.close();
      await upbeat.close();
    }
  }));

test('optional mood judge uses a bounded model request without tools and discards an outdated input judgment', () =>
  fixture(async ({ config }) => {
    const judged = { ...config, modules: { settings: { mood: { modelJudge: true } } } };
    const runtime = new ModuleRuntime(judged, [moodModule(judged)]);
    const lease = await runtime.acquire();
    let requested;
    const started = new Promise(resolve => {
      requested = resolve;
    });
    let respond;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.tools, undefined);
      assert.equal(body.stream, false);
      requested();
      return new Promise(resolve => {
        respond = () => resolve(Response.json({ choices: [{ message: { content: '{"delta":6,"confidence":0.99}' } }] }));
      });
    };
    try {
      const turn = context();
      await lease.context(turn);
      await lease.activity(turn.userText, '回复', turn);
      await started;
      await lease.context(context({ inputId: 'new', requestId: 'new', userText: '喝茶吗' }));
      respond();
      await new Promise(resolve => setTimeout(resolve, 120));
      const { getMoodStore } = await import('../lib/companion/mood.js');
      assert.ok(getMoodStore(config).snapshot(scope, options).value < 65, 'stale model output must not change the newer input');
    } finally {
      await lease.release();
      await runtime.close();
    }
  }));

test('expression decisions require configuration, remain stable on retry and do not override hourly or quiet limits', () =>
  fixture(async ({ config }) => {
    const expressionScope = { ...scope, channelId: 'expression' };
    const media = { tts: { model: 'test', voice: 'voice' }, stickerRoot: '/stickers' };
    const off = { ...config, modules: { settings: { expression: { automatic: false } } } };
    assert.deepEqual(
      planExpression(off, expressionScope, 'audio-one', media, { userText: '终于考上了，太开心了', private: true, now: Date.UTC(2026, 9, 29, 4) }),
      { voice: false, sticker: false, delayMs: 0 }
    );
    const configured = {
      ...config,
      modules: { settings: { mood: { baseline: 80 }, expression: { automatic: true, voiceChance: 1, stickerChance: 1, delayMs: [100, 200] } } }
    };
    const plan = planExpression(configured, expressionScope, 'audio-one', media, {
      userText: '终于考上了，太开心了',
      private: true,
      now: Date.UTC(2026, 9, 29, 4)
    });
    assert.equal(plan.voice, true);
    assert.equal(plan.sticker, true);
    assert.ok(plan.delayMs >= 100 && plan.delayMs <= 200);
    assert.deepEqual(
      planExpression(configured, expressionScope, 'audio-one', media, { userText: '终于考上了，太开心了', private: true, now: Date.UTC(2026, 9, 29, 4) }),
      plan
    );
    assert.equal(planExpression(configured, expressionScope, 'm', {}).voice, false);
    assert.equal(planExpression(configured, expressionScope, 'm', {}).sticker, false);
    assert.equal(automaticVoiceText('你好', 100), true);
    assert.equal(automaticVoiceText('```const a=1```', 100), false);
    assert.equal(automaticVoiceText('x'.repeat(241), 1000), false);
    const items = [
      { id: 'happy', tags: ['开心'] },
      { id: 'tea', tags: ['喝茶'] }
    ];
    assert.equal(selectExpressionSticker(items, '一起喝茶吧', 80, 'm').id, 'tea');
    assert.equal(selectExpressionSticker(items, '好呀', 80, 'm'), undefined);
    assert.equal(selectExpressionSticker(items, '替你开心', 80, 'm').id, 'happy');
    assert.equal(selectExpressionSticker(items, '好呀', 60, 'm'), undefined);
    assert.ok(selectExpressionSticker(items, '好呀', 60, 'm', true));
    assert.equal(hasStickerIntent('在不在'), true);
    assert.equal(hasStickerIntent('今天吃什么'), false);
    const intentItems = [
      { id: 'zai', name: '在呢', tags: ['可爱', '日常'], category: '日常', context: '平静招呼' },
      { id: 'ting', name: '在听', tags: ['可爱', '日常'], category: '日常', context: '回应' }
    ];
    assert.equal(selectExpressionSticker(intentItems, '在的呀', 60, 'm', false, '在不在').id, 'zai');
    assert.equal(needsTextSupplement('在不在', '在的呀'), false);
    assert.equal(needsTextSupplement('在不在，顺便帮我看看服务器', '在的，CPU 80%，建议重启'), true);
    assert.deepEqual(selectExpressionSticker(items, '好呀', 60, 'm', true), selectExpressionSticker(items, '好呀', 60, 'm', true));
    const { getMoodStore } = await import('../lib/companion/mood.js');
    const store = getMoodStore(config);
    let current;
    for (let i = 0; i < 4; i++) {
      current = store.observe(scope, `low-${i}`, 0, options);
      store.applyModel(scope, current.token, -6, options);
    }
    const policy = { cooldownSeconds: 90, maxPerHour: 6, quietHours: [1, 8], burstMax: 8 };
    assert.deepEqual(moodGroupPolicy(config, scope, policy), { ...policy, cooldownSeconds: 135 });
    assert.throws(() => expressionOptions({ modules: { settings: { expression: { delayMs: [200, 100] } } } }));
  }));

test('actual expression delivery sends automatic audio, falls back to text on TTS failure and never speaks silence', () =>
  fixture(async ({ config }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: {
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false, baseline: 80 },
          expression: { automatic: true, voiceChance: 1, stickerChance: 0, stickerIntentAlways: false, socialPolish: false }
        }
      },
      groupChat: { quietHours: [0, 0] },
      media: { speech: { engine: 'openai', fallback: false }, tts: { baseUrl: 'https://speech.test', apiKey: 'test', model: 'tts', voice: 'voice' } }
    });
    let audioFailure = false,
      modelText = '好耶，喝茶吧！';
    let modelCalls = 0,
      ttsCalls = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/audio/speech')) {
        ttsCalls++;
        assert.equal(JSON.parse(init.body).input, modelText);
        return audioFailure ? new Response('', { status: 503 }) : new Response('ID3test-audio');
      }
      modelCalls++;
      return Response.json({ choices: [{ message: { content: modelText } }] });
    };
    const texts = [],
      media = [],
      outcomes = [];
    const transport = {
      message: {
        send: async value => {
          texts.push(JSON.stringify(value.format.value));
          return [{ code: ResultCode.Ok, data: { id: 'text' } }];
        }
      },
      media: {
        send: async value => {
          media.push(value);
          return { code: ResultCode.Ok, data: { id: 'audio' } };
        }
      }
    };
    const event = { Platform: 'qq', UserId: 'one', IsPrivate: true, IsMaster: true, MessageId: 'audio-one' };
    await runDSHChat(event, '终于考上了，太开心了', { transport, onOutcome: result => outcomes.push(result) });
    assert.equal(media.length, 1);
    assert.equal(media[0].type, 'audio');
    assert.equal(texts.length, 0);
    assert.equal(outcomes[0].delivered, true);
    const callsAfterDelivery = modelCalls;
    await runDSHChat(event, '终于考上了，太开心了', { transport });
    assert.equal(modelCalls, callsAfterDelivery, 'duplicate source must not synthesize a second reply');
    await runDSHChat({ ...event, MessageId: 'audio-cooldown' }, '终于考上了，太开心了', { transport });
    assert.equal(ttsCalls, 1, 'a second emotional turn must respect voice cooldown');
    assert.equal(texts.length, 1);
    texts.length = 0;
    await runDSHChat({ ...event, MessageId: 'natural-voice' }, '请用语音回答', { transport });
    assert.equal(ttsCalls, 2);
    assert.equal(texts.length, 0, 'a natural language speech request must not stream duplicate text first');
    assert.equal(media.at(-1).type, 'audio');
    audioFailure = true;
    await runDSHChat({ ...event, MessageId: 'audio-two' }, '请用语音再说一遍', { voice: true, transport, onOutcome: result => outcomes.push(result) });
    assert.ok(texts.length > 0);
    assert.match(texts.join(''), /喝茶吧/u);
    assert.doesNotMatch(texts.join(''), /语音暂不可用/u);
    const fallbackBubbles = texts.length;
    assert.equal(outcomes.at(-1).delivered, true);
    modelText = '[沉默]';
    await runDSHChat({ ...event, MessageId: 'silence' }, '旁听', { transport, allowSilence: true, onOutcome: result => outcomes.push(result) });
    assert.equal(outcomes.at(-1).delivered, false);
    assert.equal(ttsCalls, 3);
    assert.equal(texts.length, fallbackBubbles);
  }));

test('explicit intent replies with only a matching sticker in either mode', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'stickers');
    await mkdir(stickerRoot);
    await writeFile(
      join(stickerRoot, 'manifest.json'),
      JSON.stringify([{ id: 'zai', file: 'zai.png', name: '在呢', tags: ['日常'], category: '日常', context: '平静招呼、自然回应' }])
    );
    await writeFile(join(stickerRoot, 'zai.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: {
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false },
          expression: { automatic: true, voiceChance: 0, stickerChance: 0, stickerIntentAlways: true, stickerMode: 'either' }
        }
      },
      media: { stickerRoot }
    });
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls++;
      return Response.json({ choices: [{ message: { content: '在的呀' } }] });
    };
    let texts = 0;
    let stickers = 0;
    let outcome;
    const transport = {
      message: {
        send: async () => {
          texts++;
          return [{ code: ResultCode.Ok, data: null }];
        }
      },
      media: {
        send: async () => {
          stickers++;
          return { code: ResultCode.Ok, data: { messageId: 's1' } };
        }
      }
    };
    await runDSHChat({ Platform: 'qq', UserId: 'one', IsPrivate: true, IsMaster: true, MessageId: 'intent' }, '肥鱼在吗', {
      transport,
      onOutcome: result => {
        outcome = result;
      }
    });
    assert.equal(modelCalls, 1);
    assert.equal(texts, 0);
    assert.equal(stickers, 1);
    assert.equal(outcome.delivered, true);
  }));

test('ordinary users can receive a classifier-tagged reaction through the complete chat delivery path', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'stickers');
    await mkdir(stickerRoot);
    await writeFile(
      join(stickerRoot, 'manifest.json'),
      JSON.stringify([{ id: 'learned-laugh', file: 'laugh.png', name: '笑死大笑', tags: ['大笑', '搞笑'], category: '开心' }])
    );
    await writeFile(join(stickerRoot, 'laugh.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: {
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false },
          expression: {
            automatic: true,
            voiceChance: 0,
            stickerChance: 0,
            stickerIntentAlways: true,
            stickerMode: 'either'
          }
        }
      },
      media: { stickerRoot }
    });
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '笑死' } }] });
    let texts = 0,
      images = 0,
      outcome;
    const transport = {
      message: {
        send: async () => {
          texts++;
          return [{ code: ResultCode.Ok, data: null }];
        }
      },
      media: {
        send: async () => {
          images++;
          return { code: ResultCode.Ok, data: { messageId: 'synonym-receipt' } };
        }
      }
    };
    await runDSHChat({ Platform: 'qq', UserId: 'tag-alias-member', IsPrivate: true, IsMaster: false, MessageId: 'synonym-reaction' }, '哈哈哈', {
      transport,
      onOutcome: value => {
        outcome = value;
      }
    });
    assert.equal(images, 1);
    assert.equal(texts, 0);
    assert.equal(outcome.delivered, true);
  }));

test('ordinary-user chat chooses comfort over a greeting and preserves text for mixed emotions', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'stickers');
    await mkdir(stickerRoot);
    const library = [
      { id: 'here', file: 'here.png', name: '在呢', tags: ['回应'] },
      { id: 'hug', file: 'hug.png', tags: ['拥抱'] },
      { id: 'laugh', file: 'laugh.png', tags: ['大笑', '开心'] }
    ];
    await writeFile(join(stickerRoot, 'manifest.json'), JSON.stringify(library));
    for (const item of library) await writeFile(join(stickerRoot, item.file), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: { settings: {
        memory: { automatic: false }, mood: { modelJudge: false },
        expression: { automatic: true, voiceChance: 0, stickerChance: 1, stickerIntentAlways: true, stickerMode: 'either', socialPolish: false }
      } },
      media: { stickerRoot }
    });
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '抱抱' } }] });
    for (const [index, input] of ['肥鱼在吗，我好难过', '早安，我好难过', '哈哈，其实我很难过', '我很难过，但现在好开心'].entries()) {
      const images = [], texts = [];
      const transport = {
        message: { send: async value => { texts.push(value); return [{ code: ResultCode.Ok, data: null }]; } },
        media: { send: async value => { images.push(value.name); return { code: ResultCode.Ok, data: { messageId: `emotion-${index}` } }; } }
      };
      let outcome;
      await runDSHChat({ Platform: 'qq', UserId: `ordinary-emotion-${index}`, IsPrivate: true, IsMaster: false, MessageId: `emotion-${index}` }, input, { transport, onOutcome: value => { outcome = value; } });
      assert.equal(outcome.delivered, true, input);
      assert.deepEqual(images, index < 2 ? ['hug.png'] : [], input);
      assert.equal(texts.length, index < 2 ? 0 : 1, input);
    }
  }));

test('disabled sticker module preserves text despite forced intent', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'stickers');
    await mkdir(stickerRoot);
    await writeFile(
      join(stickerRoot, 'manifest.json'),
      JSON.stringify([{ id: 'zai', file: 'zai.png', name: '在呢', tags: ['日常'], category: '日常', context: '平静招呼、自然回应' }])
    );
    await writeFile(join(stickerRoot, 'zai.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: {
        disabled: ['stickers'],
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false },
          expression: { automatic: true, voiceChance: 0, stickerChance: 0, stickerIntentAlways: true, stickerMode: 'either' }
        }
      },
      media: { stickerRoot }
    });
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls++;
      return Response.json({ choices: [{ message: { content: '在的呀' } }] });
    };
    let texts = 0;
    let stickers = 0;
    let outcome;
    const transport = {
      message: {
        send: async () => {
          texts++;
          return [{ code: ResultCode.Ok, data: null }];
        }
      },
      media: {
        send: async () => {
          stickers++;
          return { code: ResultCode.Ok, data: { messageId: 's1' } };
        }
      }
    };
    await runDSHChat({ Platform: 'qq', UserId: 'one', IsPrivate: true, IsMaster: true, MessageId: 'intent' }, '肥鱼在吗', {
      transport,
      onOutcome: result => {
        outcome = result;
      }
    });
    assert.ok(modelCalls >= 1);
    assert.equal(texts, 1);
    assert.equal(stickers, 0);
    assert.equal(outcome.delivered, true);
  }));

test('group silence decision does not send an automatic sticker', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'stickers');
    await mkdir(stickerRoot);
    await writeFile(
      join(stickerRoot, 'manifest.json'),
      JSON.stringify([{ id: 'zai', file: 'zai.png', name: '在呢', tags: ['日常'], category: '日常', context: '平静招呼、自然回应' }])
    );
    await writeFile(join(stickerRoot, 'zai.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: {
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false },
          expression: { automatic: true, voiceChance: 0, stickerChance: 0, stickerIntentAlways: true, stickerMode: 'either' }
        }
      },
      media: { stickerRoot }
    });
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls++;
      return Response.json({ choices: [{ message: { content: '[沉默]' } }] });
    };
    let texts = 0;
    let stickers = 0;
    let outcome;
    const transport = {
      message: {
        send: async () => {
          texts++;
          return [{ code: ResultCode.Ok, data: null }];
        }
      },
      media: {
        send: async () => {
          stickers++;
          return { code: ResultCode.Ok, data: { messageId: 's1' } };
        }
      }
    };
    await runDSHChat({ Platform: 'qq', UserId: 'one', IsPrivate: false, ChannelId: 'silent-group', IsMaster: false, MessageId: 'intent' }, '肥鱼在吗', {
      transport,
      allowSilence: true,
      onOutcome: result => {
        outcome = result;
      }
    });
    assert.equal(modelCalls, 1);
    assert.equal(texts, 0);
    assert.equal(stickers, 0);
    assert.equal(outcome.delivered, false);
  }));

test('group automatic reply can use a matching sticker', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'stickers');
    await mkdir(stickerRoot);
    await writeFile(
      join(stickerRoot, 'manifest.json'),
      JSON.stringify([{ id: 'zai', file: 'zai.png', name: '在呢', tags: ['日常'], category: '日常', context: '平静招呼、自然回应' }])
    );
    await writeFile(join(stickerRoot, 'zai.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: {
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false },
          expression: { automatic: true, voiceChance: 0, stickerChance: 0, stickerIntentAlways: true, stickerMode: 'either' }
        }
      },
      media: { stickerRoot }
    });
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls++;
      return Response.json({ choices: [{ message: { content: '在的呀' } }] });
    };
    let texts = 0;
    let stickers = 0;
    let outcome;
    const transport = {
      message: {
        send: async () => {
          texts++;
          return [{ code: ResultCode.Ok, data: null }];
        }
      },
      media: {
        send: async () => {
          stickers++;
          return { code: ResultCode.Ok, data: { messageId: 's1' } };
        }
      }
    };
    await runDSHChat({ Platform: 'qq', UserId: 'one', IsPrivate: false, ChannelId: 'group-sticker', IsMaster: false, MessageId: 'intent' }, '肥鱼在吗', {
      transport,
      allowSilence: true,
      onOutcome: result => {
        outcome = result;
      }
    });
    assert.equal(modelCalls, 1);
    assert.equal(texts, 0);
    assert.equal(stickers, 1);
    assert.equal(outcome.delivered, true);
  }));

test('sampled intent works when forced intent stickers are disabled', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'stickers');
    await mkdir(stickerRoot);
    await writeFile(
      join(stickerRoot, 'manifest.json'),
      JSON.stringify([{ id: 'zai', file: 'zai.png', name: '在呢', tags: ['日常'], category: '日常', context: '平静招呼、自然回应' }])
    );
    await writeFile(join(stickerRoot, 'zai.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: {
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false },
          expression: { automatic: true, voiceChance: 0, stickerChance: 1, stickerIntentAlways: false, stickerMode: 'either' }
        }
      },
      media: { stickerRoot }
    });
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls++;
      return Response.json({ choices: [{ message: { content: '在的呀' } }] });
    };
    let texts = 0;
    let stickers = 0;
    let outcome;
    const transport = {
      message: {
        send: async () => {
          texts++;
          return [{ code: ResultCode.Ok, data: null }];
        }
      },
      media: {
        send: async () => {
          stickers++;
          return { code: ResultCode.Ok, data: { messageId: 's1' } };
        }
      }
    };
    await runDSHChat({ Platform: 'qq', UserId: 'one', IsPrivate: true, IsMaster: true, MessageId: 'intent' }, '肥鱼在吗', {
      transport,

      onOutcome: result => {
        outcome = result;
      }
    });
    assert.equal(modelCalls, 1);
    assert.equal(texts, 0);
    assert.equal(stickers, 1);
    assert.equal(outcome.delivered, true);
  }));

test('sticker-first intent adds text only when the answer has extra meaning', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'stickers');
    await mkdir(stickerRoot);
    await writeFile(
      join(stickerRoot, 'manifest.json'),
      JSON.stringify([{ id: 'zai', file: 'zai.png', name: '在呢', tags: ['日常'], category: '日常', context: '平静招呼、自然回应' }])
    );
    await writeFile(join(stickerRoot, 'zai.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: {
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false },
          expression: { automatic: true, voiceChance: 0, stickerChance: 0, stickerIntentAlways: true, stickerMode: 'either' }
        }
      },
      media: { stickerRoot }
    });
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '在的，CPU 80%，建议重启。' } }] });
    const order = [];
    const transport = {
      message: {
        send: async () => {
          order.push('text');
          return [{ code: ResultCode.Ok, data: null }];
        }
      },
      media: {
        send: async () => {
          order.push('sticker');
          return { code: ResultCode.Ok, data: { messageId: 's1' } };
        }
      }
    };
    await runDSHChat({ Platform: 'qq', UserId: 'one', IsPrivate: true, IsMaster: true, MessageId: 'supplement' }, '在不在，顺便帮我看看服务器', { transport });
    assert.deepEqual(order, ['sticker', 'text']);
  }));

test('optional sticker receipt failure does not invalidate delivered text or cause a replay', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'stickers');
    await mkdir(stickerRoot);
    await writeFile(join(stickerRoot, 'manifest.json'), JSON.stringify([{ id: 'tea', file: 'tea.png', tags: ['喝茶'] }]));
    await writeFile(join(stickerRoot, 'tea.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      modules: {
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false },
          expression: { automatic: true, voiceChance: 0, stickerChance: 1, stickerMode: 'both', socialPolish: false }
        }
      },
      media: { stickerRoot }
    });
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls++;
      return Response.json({ choices: [{ message: { content: '一起喝茶吧' } }] });
    };
    let texts = 0,
      stickers = 0,
      outcome;
    const transport = {
      message: {
        send: async () => {
          texts++;
          return [{ code: ResultCode.Ok, data: null }];
        }
      },
      media: {
        send: async () => {
          stickers++;
          return { code: ResultCode.Fail };
        }
      }
    };
    const event = { Platform: 'qq', UserId: 'one', IsPrivate: true, IsMaster: true, MessageId: 'sticker' };
    await runDSHChat(event, '喝茶', {
      transport,
      onOutcome: result => {
        outcome = result;
      }
    });
    assert.equal(texts, 1);
    assert.equal(stickers, 1);
    assert.equal(outcome.delivered, true);
    const callsAfterDelivery = modelCalls;
    await runDSHChat(event, '喝茶', { transport });
    assert.equal(modelCalls, callsAfterDelivery);
  }));

test('changing persona aborts a running generation before delivery and leaves the new choice installed', () =>
  fixture(async ({ config }) => {
    const store = getPersonaStore(config);
    await store.select(scope, 'dafeiyu');
    let started;
    const ready = new Promise(resolve => {
      started = resolve;
    });
    globalThis.fetch = async (_url, init) => {
      started();
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    };
    let delivered = false;
    const running = runCoordinatedChat(
      { Platform: scope.platform, ChannelId: scope.channelId, UserId: 'one', UserKey: 'one', MessageId: 'held' },
      '等一下',
      async () => {},
      undefined,
      undefined,
      undefined,
      async () => {
        delivered = true;
      }
    );
    const rejected = assert.rejects(running, error => error.kind === 'cancelled');
    await ready;
    await resetGroupSession(scope.channelId, config, () => store.select(scope, 'assistant'));
    await rejected;
    assert.equal(delivered, false);
    assert.equal(store.selected(scope), 'assistant');
  }));

test('automatic expression with voice disabled and no stickers preserves the native QQ streaming path', () =>
  fixture(async () => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { withEventContext, ResultCode, getConfig } = await import('alemonjs');
    const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
    globalThis.__config.value['alemonjs-agent-link'].modules.settings.expression = { automatic: true, voiceChance: 1, stickerChance: 1 };
    // System speech is available by default; explicitly disable it for this text-only stream fixture.
    globalThis.__config.value['alemonjs-agent-link'].modules.disabled = ['voice'];
    globalThis.fetch = async (_url, init) => {
      assert.equal(JSON.parse(init.body).stream, true);
      return new Response('data: {"choices":[{"delta":{"content":"原生流回复"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const event = { name: 'private.message.create', Platform: 'qq-bot', BotId: 'test', UserId: 'one', IsPrivate: true, IsMaster: true, MessageId: 'native' };
    const updates = [];
    const runtime = {
      resources: new Map(),
      cleanups: new Set(),
      disposed: false,
      now: Date.now,
      api: async request => {
        assert.equal(request.payload.key, 'getMessageSeq');
        return [{ code: ResultCode.Ok, data: 1 }];
      }
    };
    const transport = {
      message: {
        send: async () => assert.fail('plain text fallback was not expected'),
        stream: async params => {
          updates.push(params);
          return { code: ResultCode.Ok, data: { id: 'stream', remainingLength: 0 } };
        }
      },
      media: { send: async () => assert.fail('no media configured') }
    };
    let outcome;
    await runtimeScope.run(runtime, () => {
      getConfig().saveValue(globalThis.__config.value);

      return withEventContext(
        event,
        async () => {},
        () =>
          runDSHChat(event, '你好', {
            transport,
            onOutcome: result => {
              outcome = result;
            }
          })
      );
    });
    assert.equal(outcome.delivered, true);
    assert.ok(updates.length > 0);
    assert.match(JSON.stringify(updates.at(-1)), /原生流回复/u);
  }));

test('mood recognizes natural direct names without treating reported speech as praise', () => {
  for (const text of ['肥鱼你真棒', '谢谢你肥鱼', '大肥鱼，辛苦你了！', '小鲸鱼，有你真好']) {
    assert.equal(keywordMoodDelta(text), 4, text);
  }
  for (const text of ['他们说肥鱼你真棒', '肥鱼说你真棒', '肥鱼，不是你真棒', '我今天很难过', '肥鱼帮我查一下']) {
    assert.equal(keywordMoodDelta(text), 0, text);
  }
  assert.equal(keywordMoodDelta('肥鱼，你这个废物'), -6);
});

test('late model correction decays both impacts from the original input time', () =>
  fixture(async ({ root }) => {
    let now = 100000;
    const store = new MoodStore(join(root, 'late-mood'), () => now);
    try {
      const first = store.observe(scope, 'late', 4, options);
      now += 6 * 3600000;
      assert.equal(store.applyModel(scope, first.token, 0, options), true);
      assert.equal(store.snapshot(scope, options).value, 60);
    } finally {
      store.close();
    }
  }));

test('unaddressed conversation does not invalidate a pending direct mood judgment', () =>
  fixture(async ({ config }) => {
    const runtime = new ModuleRuntime(config, [moodModule(config)]);
    const lease = await runtime.acquire();
    const { getMoodStore } = await import('../lib/companion/mood.js');
    try {
      await lease.context(context());
      const store = getMoodStore(config);
      const first = store.snapshot(scope, options);
      await lease.context(context({ inputId: 'bystander', requestId: 'bystander', addressed: false, userText: '随便聊聊' }));
      assert.equal(store.snapshot(scope, options).token, first.token);
      assert.equal(store.applyModel(scope, first.token, 6, options), true);
    } finally {
      await lease.release();
      await runtime.close();
    }
  }));

test('social sequence uses a sticker for greeting, text for facts, occasional angry speech, then text after apology', () =>
  fixture(async ({ root }) => {
    const { runDSHChat } = await import('../lib/response/dsh/chat.js');
    const { ResultCode } = await import('alemonjs');
    const stickerRoot = join(root, 'sequence-stickers');
    await mkdir(stickerRoot);
    await writeFile(join(stickerRoot, 'manifest.json'), JSON.stringify([{ id: 'here', name: '在呢', file: 'here.png', tags: ['招呼'] }]));
    await writeFile(join(stickerRoot, 'here.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    Object.assign(globalThis.__config.value['alemonjs-agent-link'], {
      groupChat: { quietHours: [0, 0] },
      modules: {
        disabled: ['opinions'],
        settings: {
          memory: { automatic: false },
          mood: { modelJudge: false, baseline: 30 },
          expression: { voiceChance: 1, stickerChance: 0, socialPolish: false }
        }
      },
      media: {
        stickerRoot,
        speech: { engine: 'openai', fallback: false },
        tts: { baseUrl: 'https://speech.test', apiKey: 'test', model: 'tts', voice: 'voice' }
      }
    });
    let reply = '在呢';
    const sent = [];
    let ttsCalls = 0;
    globalThis.fetch = async url => {
      if (String(url).endsWith('/audio/speech')) {
        ttsCalls++;
        return new Response('ID3test-audio');
      }
      return Response.json({ choices: [{ message: { content: reply } }] });
    };
    const transport = {
      message: {
        send: async () => {
          sent.push('text');
          return [{ code: ResultCode.Ok, data: { id: 'text' } }];
        }
      },
      media: {
        send: async value => {
          sent.push(value.type);
          return { code: ResultCode.Ok, data: { id: 'media' } };
        }
      }
    };
    const event = { Platform: 'qq', UserId: 'one', IsPrivate: true, IsMaster: true };
    const turn = async (MessageId, input, answer, expected) => {
      reply = answer;
      sent.length = 0;
      await runDSHChat({ ...event, MessageId }, input, { transport });
      assert.deepEqual(sent, [expected], input);
    };
    await turn('sequence-greeting', '肥鱼在吗', '在呢', 'image');
    await turn('sequence-facts', '帮我看服务器报错', '需要先提供日志。', 'text');
    await turn('sequence-calm', '你这个笨蛋', '先把问题说清楚。', 'text');
    await turn('audio-one', '你这个笨蛋', '够了，别这样说我！', 'audio');
    await turn('sequence-apology', '对不起，刚才说重了', '好，这事就过去了。', 'text');
    await turn('sequence-task', '那继续看报错吧', '把日志发来。', 'text');
    assert.equal(ttsCalls, 1);
  }));
