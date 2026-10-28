import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { QAStore, getQAStore } from '../lib/qa/store.js';
import { builtinQaEntries } from '../lib/qa/builtin.js';
import { isWhyQuestion, normalizeQaText } from '../lib/qa/detection.js';
import { qaModule } from '../lib/modules/qa.js';

const scope = { platform: 'qq', channelId: 'group' };
const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = async (now = Date.now) => {
  const root = await mkdtemp(join(tmpdir(), 'qa-store-'));
  const store = new QAStore(join(root, 'qa.sqlite'), now);

  return { root, store };
};

test('why-question detection covers Chinese variants and English while ignoring ordinary chat', () => {
  for (const text of ['为什么必须AT你才回答', '为啥不理我', '为何不接话', '怎么会这样', 'What is the reason?', 'why not']) {
    assert.equal(isWhyQuestion(text), true, text);
  }
  for (const text of ['今天天气不错', '怎么报名', '你好呀', '']) {
    assert.equal(isWhyQuestion(text), false, text);
  }
  assert.equal(normalizeQaText('为什么 @AT 你？'), '为什么at你');
});

test('builtin metadata is unique and every canonical question retrieves itself first', async () => {
  const { root, store } = await fixture();

  try {
    assert.equal(new Set(builtinQaEntries.map(entry => entry.id)).size, builtinQaEntries.length);
    assert.equal(new Set(builtinQaEntries.map(entry => normalizeQaText(entry.question))).size, builtinQaEntries.length);

    for (const entry of builtinQaEntries) {
      assert.ok(entry.question.length >= 4 && entry.question.length <= 300, entry.id);
      assert.ok(entry.answer.length >= 60 && entry.answer.length <= 1200, entry.id);
      assert.ok(entry.keywords.length >= 3, entry.id);
      assert.ok(entry.tags.length >= 1, entry.id);
      for (const keyword of entry.keywords) {
        const normalized = normalizeQaText(keyword);

        assert.ok(normalized.length >= 2, `${entry.id} keyword ${keyword}`);
        assert.ok(!['为什么', '为何', '什么', '怎么', '如何'].includes(normalized), `${entry.id} keyword ${keyword} is too generic`);
      }
      const hits = store.search(scope, entry.question, 3, { record: false });

      assert.equal(hits[0]?.id, entry.id, entry.id);
      assert.equal(hits[0].origin, 'builtin');
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('builtin answers cover the default failure and capability questions', async () => {
  const { root, store } = await fixture();

  try {
    const cases = {
      为什么必须AT你才回答: 'builtin-mention-only',
      为什么不理我: 'builtin-after-mention-silent',
      '为什么@你之后还是没有回复': 'builtin-after-mention-silent',
      为什么你在群里不主动接话: 'builtin-no-proactive',
      为什么回复这么慢: 'builtin-slow-queue',
      为什么你记不住刚才说的: 'builtin-forget',
      为什么你不能上网查资料: 'builtin-no-web-files',
      为什么你不能发语音: 'builtin-no-media',
      为什么你不能禁言: 'builtin-no-group-admin',
      为什么私聊你不回: 'builtin-private-no-reply',
      为什么额度不足: 'builtin-quota'
    };

    for (const [question, id] of Object.entries(cases)) {
      const hits = store.search(scope, question, 3);

      assert.equal(hits[0]?.id, id, question);
      assert.equal(hits[0].origin, 'builtin');
    }
    for (const question of ['为什么必须AT你才回答', '为什么必须@你才回答', '为什么一定要艾特你', '为什么群里不理我']) {
      const hits = store.search(scope, question, 3);

      assert.equal(hits[0]?.id, 'builtin-mention-only', question);
      assert.match(hits[0].answer, /接收全面消息/u);
    }
    const broad = store.search(scope, '为什么不回复', 3);

    assert.equal(broad.length, 1);
    assert.equal(broad[0].id, 'builtin-after-mention-silent');
    for (const question of [
      '为什么天空是蓝的',
      '为什么必须听你的',
      '为什么必须这样',
      '为什么这个 chat 没人说话',
      '今天天气怎么样',
      '为什么 1+1=2',
      '为什么你会唱歌',
      '为什么不能用'
    ]) {
      assert.equal(store.search(scope, question, 3).length, 0, question);
    }
    assert.equal(store.search({ platform: 'qq', channelId: 'other' }, '为什么必须AT你才回答', 3)[0].id, 'builtin-mention-only');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('learned why answers stay inside their session, deduplicate, and become retrievable', async () => {
  const { root, store } = await fixture();
  const other = { platform: 'qq', channelId: 'other' };

  try {
    const learned = store.learn(scope, { question: '为什么今天群里这么安静', answer: '可能大家都在忙，或者静默时段到了。' });

    assert.ok(learned);
    assert.equal(learned.origin, 'learned');
    assert.equal(store.search(scope, '为什么今天群里这么安静呀', 3)[0]?.id, learned.id);
    assert.equal(store.search(other, '为什么今天群里这么安静', 3).length, 0);
    assert.equal(store.search(scope, '今天天气怎么样', 3).length, 0);
    const again = store.learn(scope, { question: '为什么今天群里这么安静？', answer: '也可能只是暂时没人说话。' });

    assert.equal(again.id, learned.id);
    assert.equal(again.answer, '也可能只是暂时没人说话。');
    assert.equal(store.list(scope).length, 1);
    assert.equal(store.learn(scope, { question: '为什么这个没有答案', answer: '我不确定这个问题的答案。' }), undefined);
    assert.equal(store.learn(scope, { question: '为什么这个也不该记录', answer: '服务暂时不可用，请稍后再试。' }), undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit answers upgrade learned entries and can be published globally for every session', async () => {
  const { root, store } = await fixture();
  const other = { platform: 'qq', channelId: 'other' };

  try {
    store.learn(scope, { question: '为什么必须AT你才回答', answer: '因为群消息没有全部接收。' });
    const local = store.addExplicit(scope, { question: '为什么必须AT你才回答', answer: '需要在 qq-bot 开启接收全部群消息。', keywords: ['at', '艾特'] });

    assert.equal(local.origin, 'explicit');
    assert.equal(local.confidence, 1);
    assert.equal(store.search(scope, '为什么必须AT你才回答', 3)[0].answer, '需要在 qq-bot 开启接收全部群消息。');
    const global = store.addExplicit('global', { question: '为什么这个群要遵守群规', answer: '因为群规是群成员共同约定。' });

    assert.equal(global.scope, 'global');
    assert.equal(store.search(other, '为什么这个群要遵守群规', 3)[0].id, global.id);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('owner correction to a global answer survives a restart instead of being reset by the builtin seed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-restart-'));
  const path = join(root, 'qa.sqlite');

  try {
    const first = new QAStore(path);

    first.addExplicit('global', { question: '为什么必须@你（AT你）才回答？', answer: '主人修正后的答案。' });
    first.close();
    const second = new QAStore(path);
    const hits = second.search(scope, '为什么必须AT你才回答', 3);

    assert.equal(hits[0].origin, 'explicit');
    assert.equal(hits[0].answer, '主人修正后的答案。');
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('question log, capacity, purge and retention cleanup keep scoped data bounded', async () => {
  let now = Date.now();
  const { root, store } = await fixture(() => now);

  try {
    assert.ok(store.learn(scope, { question: '为什么第一条', answer: '第一条答案内容。' }, 1));
    assert.equal(store.learn(scope, { question: '为什么第二条', answer: '第二条答案内容。' }, 1), undefined);
    for (let index = 0; index < 3; index++) {
      store.recordAsked(scope, { userId: 'one', question: `为什么记录 ${index}`, answer: '已送达的回答内容。', matchedId: 'builtin-mention-only' });
    }
    assert.equal(store.recentQuestions(scope).length, 3);
    assert.equal(store.recentQuestions(scope)[0].matchedId, 'builtin-mention-only');
    store.purgeHash(hash('group'));
    assert.equal(store.list(scope).length, 0);
    assert.equal(store.recentQuestions(scope).length, 0);
    assert.equal(store.search(scope, '为什么必须AT你才回答', 3).length, 1);
    store.observe(scope);
    store.learn(scope, { question: '为什么会被清理', answer: '因为会话长期没有活动。' });
    now += 40 * 86400000;
    store.cleanup(30);
    assert.equal(store.list(scope).length, 0);
    assert.equal(store.recentQuestions(scope).length, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('qa module injects confirmed answers, records why questions, and learns unmatched replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qa-module-'));
  const oldConfig = globalThis.__config;

  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'workspaces'),
        dshHomeRoot: join(root, 'homes'),
        modules: { settings: { qa: { autoRecord: true } } }
      }
    }
  };
  const { getDSHConfig } = await import('../lib/dsh/client.js');
  const config = getDSHConfig();
  const hooks = { context: [], activity: [] };
  const tools = [];
  const module = qaModule(config);
  const api = {
    id: 'qa',
    dataDirectory: join(root, 'data'),
    settings: {},
    tool: tool => tools.push(tool),
    on: (name, handler) => hooks[name].push(handler),
    onDispose: () => undefined
  };

  try {
    module.setup(api);
    const store = getQAStore(config);
    const base = {
      requestId: 'request-1',
      inputId: 'message-1',
      channelId: 'group',
      userId: 'one',
      platform: 'qq',
      private: false,
      owner: false,
      autonomous: false,
      addressed: true,
      capabilities: { chat: true, web: false, files: false, terminal: false },
      signal: new AbortController().signal
    };
    const question = { ...base, userText: '为什么必须AT你才回答' };
    const injected = await hooks.context[0](question);

    assert.match(injected, /接收全面消息/u);
    assert.match(injected, /builtin/u);
    await hooks.activity[0]({ input: question.userText, output: '因为 qq-bot 没有开启接收全面消息。' }, question);
    assert.equal(store.recentQuestions(scope)[0].matchedId, 'builtin-mention-only');
    const unmatched = { ...base, requestId: 'request-2', inputId: 'message-2', userText: '为什么今天群里这么安静' };

    assert.match(await hooks.context[0](unmatched), /没有直接匹配/u);
    await hooks.activity[0]({ input: unmatched.userText, output: '可能大家都在忙，或者静默时段到了。' }, unmatched);
    assert.ok(store.list(scope).some(item => item.question === '为什么今天群里这么安静' && item.origin === 'learned'));
    assert.equal(store.recentQuestions(scope)[0].matchedId, undefined);
    const search = tools.find(tool => tool.name === 'search_qa');

    assert.ok(search);
    assert.ok(search.available(base));
    const result = await search.execute({ query: '为什么必须AT你才回答' }, base);

    assert.equal(result.items[0].source, 'builtin');
    const remember = tools.find(tool => tool.name === 'remember_qa');

    assert.ok(remember);
    assert.equal(remember.available({ ...base, owner: true }), true);
    assert.equal(remember.available(base), false);
    const denied = await remember.execute({ question: '为什么测试', answer: '测试答案内容。' }, { ...base, owner: true, userText: '今天天气不错' });

    assert.equal(denied.ok, false);
    const saved = await remember.execute(
      { question: '为什么测试', answer: '测试答案内容。', scope: 'session' },
      { ...base, owner: true, userText: '记住这个问答：为什么测试' }
    );

    assert.equal(saved.ok, true);
    assert.equal(store.search(scope, '为什么测试', 3)[0].origin, 'explicit');
    const ordinary = { ...base, requestId: 'request-3', userText: '今天天气不错' };

    assert.equal(await hooks.context[0](ordinary), '');
    await hooks.activity[0]({ input: ordinary.userText, output: '适合出门。' }, ordinary);
    assert.equal(store.recentQuestions(scope).length, 2);
  } finally {
    globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
});
