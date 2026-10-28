import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { QAStore } from '../lib/qa/store.js';
import { isWhyQuestion, normalizeQaText } from '../lib/qa/detection.js';
import { qaModule } from '../lib/modules/qa.js';
import { getQAStore } from '../lib/qa/store.js';

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

test('builtin mention-only answer matches real why questions but not unrelated ones', async () => {
  const { root, store } = await fixture();

  try {
    for (const question of ['为什么必须AT你才回答', '为什么必须@你才回答', '为什么不理我', '为什么一定要艾特你', '为什么你不主动接话']) {
      const hits = store.search(scope, question, 3);

      assert.ok(hits.length, question);
      assert.equal(hits[0].origin, 'builtin');
      assert.match(hits[0].answer, /接收全面消息/u);
    }
    for (const question of ['为什么天空是蓝的', '为什么必须听你的', '为什么必须这样', '今天天气怎么样']) {
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
