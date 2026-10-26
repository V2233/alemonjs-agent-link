import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolChat } from '../lib/agent/tool-chat.js';
import { validateArguments } from '../lib/agent/schema.js';

const context = signal => ({
  channelId: 'private:one',
  userId: 'one',
  platform: 'qq',
  private: true,
  owner: false,
  userText: '帮我记住偏好',
  capabilities: { chat: true, web: false, files: false, terminal: false },
  signal
});
const config = {
  model: 'test',
  provider: 'deepseek-official',
  defaultSystemPrompt: '友好助手',
  maxRequestBytes: 100000,
  inputBlockedKeywords: [],
  outputBlockedKeywords: []
};
const call = (id, args = '{"text":"茶"}', name = 'remember') => ({ id, type: 'function', function: { name, arguments: args } });
const options = (tools, signal = new AbortController().signal) => ({
  config,
  credentials: { apiKey: 'test' },
  input: '记住我喜欢茶',
  context: context(signal),
  tools,
  maxRounds: 3
});

test('tool loop returns real results to the model, retains reasoning, and does not execute a repeated call twice', async () => {
  const original = globalThis.fetch;
  let writes = 0;
  let requests = 0;
  const tool = {
    name: 'remember',
    description: '保存资料',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async args => {
      writes++;
      return { ok: true, saved: args.text };
    }
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests++;
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.tools.length, 1);
    if (requests === 1) {
      return Response.json({ choices: [{ message: { content: null, reasoning_content: 'private reasoning', tool_calls: [call('one')] } }] });
    }
    assert.equal(body.messages.find(m => m.role === 'assistant').reasoning_content, 'private reasoning');
    assert.deepEqual(JSON.parse(body.messages.find(m => m.role === 'tool').content), { ok: true, saved: '茶' });
    return Response.json({ choices: [{ message: requests === 2 ? { tool_calls: [call('one')] } : { content: '记住了。' } }] });
  };
  try {
    assert.equal(await runToolChat(options([tool])), '记住了。');
    assert.equal(writes, 1);
    assert.equal(requests, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('unauthorized names and conflicting call IDs fail before further actions', async () => {
  const original = globalThis.fetch;
  let writes = 0;
  let requests = 0;
  const tool = {
    name: 'remember',
    description: 'x',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => {
      writes++;
      return { ok: true };
    }
  };
  try {
    globalThis.fetch = async () => Response.json({ choices: [{ message: { tool_calls: [call('one', '{}', 'terminal')] } }] });
    await assert.rejects(runToolChat(options([tool])), /未授权/);
    assert.equal(writes, 0);
    globalThis.fetch = async () => Response.json({ choices: [{ message: { tool_calls: [call('one', ++requests === 1 ? '{"text":"a"}' : '{"text":"b"}')] } }] });
    await assert.rejects(runToolChat(options([tool])), /不一致/);
    assert.equal(writes, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('tool errors and malformed arguments return failure without leaking exception details', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  let runs = 0;
  const tool = {
    name: 'remember',
    description: 'x',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async () => {
      runs++;
      throw new Error('apiKey=do-not-leak');
    }
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests++;
    if (requests < 3) {
      return Response.json({ choices: [{ message: { tool_calls: [call(String(requests), requests === 1 ? '{"text":5}' : '{"text":"a"}')] } }] });
    }
    const results = body.messages.filter(m => m.role === 'tool');
    assert.equal(results.length, 2);
    assert.ok(results.every(m => JSON.parse(m.content).ok === false));
    assert.ok(!JSON.stringify(body).includes('do-not-leak'));
    return Response.json({ choices: [{ message: { content: '保存失败。' } }] });
  };
  try {
    assert.equal(await runToolChat(options([tool])), '保存失败。');
    assert.equal(runs, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('cancellation and round budget prevent subsequent tool side effects', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let runs = 0;
  let requests = 0;
  const tool = {
    name: 'remember',
    description: 'x',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => {
      runs++;
      controller.abort();
      return { ok: true };
    }
  };
  globalThis.fetch = async () => Response.json({ choices: [{ message: { tool_calls: [call(String(++requests))] } }] });
  try {
    await assert.rejects(runToolChat(options([tool], controller.signal)), { name: 'AbortError' });
    assert.equal(runs, 1);
    assert.equal(requests, 1);
    const limited = {
      ...tool,
      execute: async () => {
        runs++;
        return { ok: true };
      }
    };
    await assert.rejects(runToolChat({ ...options([limited]), maxRounds: 1 }), /上限/);
    assert.equal(runs, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('execution validation rejects extra keys, prototype keys, nonfinite values and oversized collections', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['n'] };
  for (const value of [{ n: 0 }, { n: 1.5 }, { n: Infinity }, { n: 2, unexpected: true }, JSON.parse('{"n":2,"__proto__":{}}')]) {
    assert.throws(() => validateArguments(schema, value));
  }
  validateArguments(schema, { n: 2 });
  assert.throws(() => validateArguments({ type: 'array', items: { type: 'string' }, maxItems: 1 }, ['a', 'b']));
});
