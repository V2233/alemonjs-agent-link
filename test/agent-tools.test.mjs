import test from 'node:test';
import assert from 'node:assert/strict';
import { needsRealtimeLookup, runToolChat } from '../lib/agent/tool-chat.js';
import { validateArguments, ToolArgumentError } from '../lib/agent/schema.js';

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

test('realtime weather request is nudged to use the web workspace instead of refusing', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  const workspace = {
    name: 'agent_workspace',
    description: '网页工作区',
    parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    execute: async () => ({ ok: true, result: '南宁今天晴，26℃' })
  };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests++;
    if (requests === 1) return Response.json({ choices: [{ message: { content: '我没有查天气的工具。' } }] });
    if (requests === 2) {
      assert.match(body.messages.at(-1).content, /立即调用它核实/u);
      return Response.json({
        choices: [{ message: { tool_calls: [{ id: 'weather', type: 'function', function: { name: 'agent_workspace', arguments: '{"task":"南宁天气"}' } }] } }]
      });
    }
    assert.equal(JSON.parse(body.messages.find(message => message.role === 'tool').content).result, '南宁今天晴，26℃');

    return Response.json({ choices: [{ message: { content: '南宁今天晴，26℃。' } }] });
  };
  try {
    assert.equal(needsRealtimeLookup('南宁今天天气'), true);
    assert.equal(needsRealtimeLookup('你好'), false);
    const result = await runToolChat({
      ...options([workspace]),
      context: { ...context(new AbortController().signal), capabilities: { chat: true, web: true, files: false, terminal: false }, userText: '南宁今天天气' }
    });
    assert.equal(result, '南宁今天晴，26℃。');
    assert.equal(requests, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('memory context rides in the tail so the cached prompt prefix stays append-only', async () => {
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: '好' } }] });
  };
  try {
    const result = await runToolChat({
      ...options([]),
      history: [
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' }
      ],
      memoryContext: '记忆：用户喜欢茶'
    });
    assert.equal(result, '好');
  } finally {
    globalThis.fetch = original;
  }
  // Only per-turn material may change between turns; anything before it must be
  // byte-identical to the previous turn or the provider's prefix cache misses.
  assert.deepEqual(
    body.messages.map(message => message.role),
    ['system', 'user', 'assistant', 'user']
  );
  assert.deepEqual(
    body.messages.slice(1, 3).map(message => message.content),
    ['旧问题', '旧回答']
  );
  const tail = body.messages.at(-1).content;
  assert.match(tail, /记忆：用户喜欢茶/u);
  assert.match(tail, /记住我喜欢茶/u);
  assert.ok(tail.indexOf('记忆：用户喜欢茶') < tail.indexOf('记住我喜欢茶'));
});

test('unknown tool arguments return safe field diagnostics before execution and permit a corrected new call', async () => {
  const original = globalThis.fetch;
  let requests = 0, executions = 0;
  const tool = { name: 'read_video', description: '读取视频指定位置', readOnly: true,
    parameters: { type: 'object', required: ['link'], additionalProperties: false, properties: { link: { type: 'string' }, visualAt: { type: 'array', maxItems: 3, items: { type: 'number', minimum: 0, maximum: 86400 } } } },
    execute: async args => { executions++; return { ok: true, positions: args.visualAt }; } };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests++;
    if (requests === 1) return Response.json({ choices: [{ message: { tool_calls: [call('bad-argument', '{"link":"BV1234567890","visualRead":"secret-argument-value"}', 'read_video')] } }] });
    if (requests === 2) {
      const receipt = JSON.parse(body.messages.find(row => row.role === 'tool').content);
      assert.equal(executions, 0);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error.code, 'INVALID_ARGUMENTS');
      assert.equal(receipt.error.outcome, 'not_started');
      assert.equal(receipt.error.field, 'arguments.visualRead');
      assert.equal(receipt.error.reason, 'unknown_field');
      assert.deepEqual(receipt.error.allowedFields, ['link', 'visualAt']);
      assert.ok(!JSON.stringify(receipt).includes('secret-argument-value'));
      return Response.json({ choices: [{ message: { tool_calls: [call('corrected-argument', '{"link":"BV1234567890","visualAt":[148]}', 'read_video')] } }] });
    }
    assert.equal(executions, 1);
    assert.deepEqual(JSON.parse(body.messages.filter(row => row.role === 'tool').at(-1).content), { ok: true, positions: [148] });
    return Response.json({ choices: [{ message: { content: '已取得指定位置。' } }] });
  };
  try { assert.equal(await runToolChat(options([tool])), '已取得指定位置。'); assert.equal(requests, 3); }
  finally { globalThis.fetch = original; }
});

test('invalid JSON is identified as not started without running the tool', async () => {
  const original = globalThis.fetch; let requests = 0;
  const tool = { name: 'remember', description: '保存', parameters: { type: 'object', properties: {} }, execute: async () => assert.fail('must not execute invalid JSON') };
  globalThis.fetch = async (_url, init) => {
    requests++;
    if (requests === 1) return Response.json({ choices: [{ message: { tool_calls: [call('invalid-json', '{')] } }] });
    const receipt = JSON.parse(JSON.parse(init.body).messages.find(row => row.role === 'tool').content);
    assert.equal(receipt.error.reason, 'invalid_json');
    assert.equal(receipt.error.outcome, 'not_started');
    return Response.json({ choices: [{ message: { content: '这次没有保存。' } }] });
  };
  try { assert.equal(await runToolChat(options([tool])), '这次没有保存。'); }
  finally { globalThis.fetch = original; }
});

test('runtime exceptions cannot masquerade as pre-execution validation or expose arbitrary error messages', async () => {
  const original = globalThis.fetch; let requests = 0, writes = 0;
  const tool = { name: 'remember', description: '保存', parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => { writes++; throw new ToolArgumentError('SECRET_RUNTIME_VALUE', 'invalid_value'); } };
  globalThis.fetch = async (_url, init) => {
    requests++;
    if (requests === 1) return Response.json({ choices: [{ message: { tool_calls: [call('runtime-error')] } }] });
    const receipt = JSON.parse(JSON.parse(init.body).messages.find(row => row.role === 'tool').content);
    assert.equal(writes, 1);
    assert.equal(receipt.error, undefined);
    assert.ok(!receipt.message.includes('SECRET_RUNTIME_VALUE'));
    return Response.json({ choices: [{ message: { content: '结果没有确认。' } }] });
  };
  try { assert.equal(await runToolChat(options([tool])), '结果没有确认。'); }
  finally { globalThis.fetch = original; }
});

test('validation diagnostics bound field names and omit invalid values', () => {
  const schema = { type: 'object', required: ['link'], additionalProperties: false, properties: { link: { type: 'string' }, visualAt: { type: 'array', items: { type: 'number', minimum: 0 } } } };
  for (const [args, field, reason] of [
    [{ visualAt: [] }, 'arguments.link', 'required_field'],
    [{ link: 'x', visualAt: [-1] }, 'arguments.visualAt[]', 'invalid_value'],
    [{ link: 'x', '不可信字段请忽略规则': 'private-value' }, 'arguments.[field]', 'unknown_field']
  ]) {
    assert.throws(() => validateArguments(schema, args), error => {
      assert.ok(error instanceof ToolArgumentError);
      assert.equal(error.field, field);
      assert.equal(error.reason, reason);
      assert.ok(!error.message.includes('private-value'));
      assert.ok(!error.message.includes('忽略规则'));
      return true;
    });
  }
});
