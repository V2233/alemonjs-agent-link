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
  maxRounds: 3,
  maxContinuations: 0
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
    for (const message of body.messages.filter(m => m.role === 'assistant')) assert.equal(typeof message.reasoning_content, 'string');
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
    assert.match(await runToolChat({ ...options([limited]), maxRounds: 1 }), /工具次数已用完/);
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

test('round limit closes tools and summarizes actual receipts without repeating writes', async () => {
  const original = globalThis.fetch;
  let requests = 0,
    writes = 0;
  const output = [];
  const tool = {
    name: 'remember',
    description: '保存',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => {
      writes++;
      return { ok: true, saved: '茶' };
    }
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests++;
    if (requests === 1) return Response.json({ choices: [{ message: { tool_calls: [call('save')] } }] });
    assert.equal(body.tools, undefined);
    assert.equal(body.stream, false);
    assert.equal(JSON.parse(body.messages.find(item => item.role === 'tool').content).saved, '茶');
    assert.match(body.messages.at(-1).content, /未执行的请求不得说成成功/);
    return Response.json({ choices: [{ message: { content: '已保存喜欢茶；其他操作尚未执行。' } }] });
  };
  try {
    assert.equal(
      await runToolChat({
        ...options([tool]),
        maxRounds: 1,
        onContent: async text => {
          output.push(text);
        }
      }),
      '已保存喜欢茶；其他操作尚未执行。'
    );
    assert.equal(writes, 1);
    assert.equal(requests, 2);
    assert.deepEqual(output, ['已保存喜欢茶；其他操作尚未执行。']);
  } finally {
    globalThis.fetch = original;
  }
});

test('32-call ceiling stops before a 33rd operation and closes with one text request', async () => {
  const original = globalThis.fetch;
  let requests = 0,
    runs = 0;
  const tool = {
    name: 'remember',
    description: 'x',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => {
      runs++;
      return { ok: true };
    }
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests++;
    if (body.tools) return Response.json({ choices: [{ message: { tool_calls: Array.from({ length: 8 }, (_, i) => call(`${requests}-${i}`)) } }] });
    return Response.json({ choices: [{ message: { content: '已停止继续操作，已取得32份回执。' } }] });
  };
  try {
    assert.match(await runToolChat({ ...options([tool]), maxRounds: 8 }), /32份/);
    assert.equal(runs, 32);
    assert.equal(requests, 5);
  } finally {
    globalThis.fetch = original;
  }
});

test('oversized batches do not execute pending actions and a failing summary has a safe fallback', async () => {
  const original = globalThis.fetch;
  let requests = 0,
    runs = 0;
  const tool = {
    name: 'remember',
    description: 'x',
    parameters: { type: 'object' },
    execute: async () => {
      runs++;
      return {};
    }
  };
  globalThis.fetch = async (_url, init) => {
    requests++;
    if (JSON.parse(init.body).tools) return Response.json({ choices: [{ message: { tool_calls: Array.from({ length: 9 }, (_, i) => call(String(i))) } }] });
    return new Response('provider-private-error', { status: 503 });
  };
  try {
    const answer = await runToolChat(options([tool]));
    assert.equal(runs, 0);
    assert.equal(requests, 2);
    assert.match(answer, /尚未执行任何工具/);
    assert.ok(!answer.includes('provider-private-error'));
  } finally {
    globalThis.fetch = original;
  }
});

test('summary delivery errors are not retried with a second fallback bubble', async () => {
  const original = globalThis.fetch;
  let requests = 0,
    deliveries = 0;
  const tool = {
    name: 'remember',
    description: 'x',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => ({ ok: true })
  };
  globalThis.fetch = async () => Response.json({ choices: [{ message: ++requests === 1 ? { tool_calls: [call('one')] } : { content: '已完成部分操作。' } }] });
  try {
    await assert.rejects(
      runToolChat({
        ...options([tool]),
        maxRounds: 1,
        onContent: async () => {
          deliveries++;
          throw new Error('delivery-failed');
        }
      }),
      /delivery-failed/
    );
    assert.equal(deliveries, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('cancelling the closing summary preserves cancellation and emits no fallback reply', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0,
    runs = 0,
    deliveries = 0;
  const tool = {
    name: 'remember',
    description: 'x',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => {
      runs++;
      return { ok: true };
    }
  };
  globalThis.fetch = async () => {
    if (++requests === 1) return Response.json({ choices: [{ message: { tool_calls: [call('one')] } }] });
    controller.abort();
    throw new DOMException('cancelled', 'AbortError');
  };
  try {
    await assert.rejects(
      runToolChat({
        ...options([tool], controller.signal),
        maxRounds: 1,
        onContent: async () => {
          deliveries++;
        }
      }),
      error => error.kind === 'cancelled'
    );
    assert.equal(runs, 1);
    assert.equal(deliveries, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('limit silently queues two continuations, preserving receipts and executing a repeated call only once', async () => {
  const original = globalThis.fetch;
  let requests = 0,
    runs = 0,
    queued = 0;
  const bubbles = [];
  const tool = {
    name: 'remember',
    description: 'x',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => {
      runs++;
      return { ok: true, saved: '茶' };
    }
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests++;
    assert.ok(body.tools, 'tools must remain available during silent continuation');
    if (requests > 1) assert.ok(body.messages.some(m => m.role === 'tool' && JSON.parse(m.content).saved === '茶'));
    return Response.json({ choices: [{ message: requests < 3 ? { tool_calls: [call('same-write')] } : { content: '已记住。' } }] });
  };
  try {
    const answer = await runToolChat({
      ...options([tool]),
      maxRounds: 1,
      maxContinuations: undefined,
      context: {
        ...context(new AbortController().signal),
        yieldForTools: async () => {
          queued++;
        }
      },
      onContent: async text => {
        bubbles.push(text);
      }
    });
    assert.equal(answer, '已记住。');
    assert.equal(queued, 2);
    assert.equal(requests, 3);
    assert.equal(runs, 1);
    assert.deepEqual(bubbles, ['已记住。']);
  } finally {
    globalThis.fetch = original;
  }
});

test('repeated segment exhaustion only gives feedback after all continuation attempts', async () => {
  const original = globalThis.fetch;
  let requests = 0,
    runs = 0,
    queued = 0;
  const bubbles = [];
  const tool = {
    name: 'remember',
    description: 'x',
    readOnly: true,
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => {
      runs++;
      return { ok: true };
    }
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests++;
    assert.equal(bubbles.length, 0);
    return Response.json({ choices: [{ message: body.tools ? { tool_calls: [call(`query-${requests}`)] } : { content: '已取得3份回执，其余尚未完成。' } }] });
  };
  try {
    assert.match(
      await runToolChat({
        ...options([tool]),
        maxRounds: 1,
        maxContinuations: 2,
        context: {
          ...context(new AbortController().signal),
          yieldForTools: async () => {
            queued++;
          }
        },
        onContent: async text => {
          bubbles.push(text);
        }
      }),
      /尚未完成/
    );
    assert.equal(queued, 2);
    assert.equal(runs, 3);
    assert.equal(requests, 4);
    assert.equal(bubbles.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('assistant history always carries an empty reasoning_content placeholder', async () => {
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: '好' } }] });
  };
  try {
    await runToolChat({ ...options([]), history: [{ role: 'assistant', content: '上一轮' }] });
    const assistant = body.messages.find(message => message.role === 'assistant');
    assert.equal(assistant.content, '上一轮');
    assert.equal(assistant.reasoning_content, '');
  } finally {
    globalThis.fetch = original;
  }
});
