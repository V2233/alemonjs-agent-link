// Real installed DSH + fake local model + real framework MCP. No paid requests or QQ writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Expose, registerExpose, disposeExpose, withEventContext, getCurrentEvent } from 'alemonjs';
import { exposeModule } from '../lib/modules/expose.js';
import { startFrameworkMcp } from '../lib/platform/mcp.js';
const exposeMode = process.argv.includes('--expose');
const twoTurns = process.argv.includes('--two-turns');
const unknownEffect = process.argv.includes('--unknown-effect');
const previousConfig = globalThis.__config;
globalThis.__config = { value: { 'alemonjs-agent-link': { aiEnabled: true } } };
const root = await mkdtemp(join(tmpdir(), 'agent-link-mcp-runtime-'));
const python = process.env.AGENT_LINK_TEST_PYTHON || resolve('.data/agent-link/venv/bin/python');
let executed = 0;
let requests = 0;
let failure;
const event = { name: 'message.create', Platform: 'qq-bot', BotId: '900', ChannelId: '200', UserId: '100', IsPrivate: false };
const context = {
  platform: 'qq-bot',
  botId: '900',
  channelId: '200',
  userId: '100',
  private: false,
  owner: false,
  requestId: 'fixture-turn',
  capabilities: { chat: true },
  signal: new AbortController().signal
};
const exposeTools = [];
if (exposeMode) {
  registerExpose('fixture-game', [
    {
      name: 'fixture.player.v1',
      description: 'Fixture game',
      actions: {
        stats: Expose.action({
          description: 'Current player stats',
          effect: unknownEffect ? 'unknown' : 'read',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: { type: 'object', properties: { hp: { type: 'integer' } }, required: ['hp'], additionalProperties: false },
          authorize: (_input, call) => call.callerApp === 'alemonjs-agent-link' && getCurrentEvent()?.UserId === '100',
          handler: async () => {
            executed++;
            return { hp: 42 };
          }
        })
      }
    }
  ]);
  exposeModule().setup({ settings: {}, tool: tool => exposeTools.push(tool) });
}
const bridge = await withEventContext(
  event,
  () => {},
  () =>
    startFrameworkMcp(
      exposeMode
        ? exposeTools
        : [
            {
              name: 'fixture_group_info',
              readOnly: true,
              description: 'Query current group',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
              execute: async () => {
                executed++;
                return { name: '测试群', memberCount: 42 };
              }
            }
          ],
      context
    ),
  { appName: 'alemonjs-agent-link' }
);
const model = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const messagesApi = request.url.includes('/messages');
    const names = (body.tools || []).map(tool => tool.function?.name || tool.name);
    assert.ok(names.includes('mcp__framework__discover'), JSON.stringify(names));
    assert.ok(names.includes('mcp__framework__call'), JSON.stringify(names));
    const step = requests++;
    if (twoTurns && step > (exposeMode ? 4 : 3)) {
      assert.ok(
        body.messages.some(item => item.role === 'assistant' && JSON.stringify(item.content).includes('测试群有42人')),
        'native DSH history was not restored'
      );
    }
    const target = { protocol: 'fixture.player.v1', provider: 'fixture-game', action: 'stats' };
    const choices = exposeMode
      ? [
          ['mcp__framework__discover', {}],
          ['mcp__framework__call', { name: 'expose_discover', argumentsJson: '{}' }],
          ['mcp__framework__call', { name: 'expose_discover', argumentsJson: JSON.stringify(target) }],
          ['mcp__framework__call', { name: unknownEffect ? 'expose_call' : 'expose_read', argumentsJson: JSON.stringify({ ...target, argumentsJson: '{}' }) }]
        ]
      : [
          ['mcp__framework__discover', {}],
          ['mcp__framework__discover', { name: 'fixture_group_info' }],
          ['mcp__framework__call', { name: 'fixture_group_info', argumentsJson: '{}' }]
        ];
    if (step === choices.length) assert.ok(JSON.stringify(body.messages).includes('42'));
    const message =
      step < choices.length
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `fixture-${step}`, type: 'function', function: { name: choices[step][0], arguments: JSON.stringify(choices[step][1]) } }]
          }
        : { role: 'assistant', content: '测试群有42人。' };
    if (messagesApi) {
      const content =
        step < choices.length
          ? { type: 'tool_use', id: `fixture-${step}`, name: choices[step][0], input: choices[step][1] }
          : { type: 'text', text: '测试群有42人。' };
      const stop = step < choices.length ? 'tool_use' : 'end_turn';
      const messageValue = {
        id: `fixture-${step}`,
        type: 'message',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [content],
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      };
      if (body.stream) {
        const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          [
            { type: 'message_start', message: { ...messageValue, content: [], stop_reason: null } },
            { type: 'content_block_start', index: 0, content_block: content.type === 'tool_use' ? { ...content, input: {} } : { type: 'text', text: '' } },
            {
              type: 'content_block_delta',
              index: 0,
              delta:
                content.type === 'tool_use'
                  ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) }
                  : { type: 'text_delta', text: content.text }
            },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: 'message_stop' }
          ]
            .map(frame)
            .join('')
        );
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(messageValue));
      }
    } else if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool, index) => ({ index, ...tool })) } : {}) };
      response.end(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: step < choices.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`
      );
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, message, finish_reason: step < choices.length ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      );
    }
  } catch (error) {
    failure = error;
    response.writeHead(500);
    response.end('{}');
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
try {
  const code = `import sys, threading, atexit, signal
sys.path.insert(0, ${JSON.stringify(resolve('python'))})
import dsh_bridge as b
from pathlib import Path
b.RUNTIME_ROOT=Path(${JSON.stringify(join(root, 'runtime'))})
b.WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
b.HOME_ROOT.mkdir(parents=True, exist_ok=True)
b.RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
assert b.sandbox_self_test() is None
# Only the local fixture's HTTP model URL bypasses production HTTPS preflight.
b.validate_preflight=lambda: None
atexit.register(b.close_workers)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
server=b.ThreadingHTTPServer(('127.0.0.1',0), b.Handler)
print(server.server_port, flush=True)
server.serve_forever()
`;
  const child = spawn(python, ['-c', code], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      DSH_WORKSPACE_ROOT: join(root, 'workspaces'),
      DSH_HOME_ROOT: join(root, 'homes'),
      DSH_BRIDGE_TOKEN: 'fixture-token',
      DEEPSEEK_API_KEY: 'fixture',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      DSH_WORKER_TIMEOUT_SECONDS: '45'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', data => (stderr += data));
  const timer = setTimeout(() => child.kill('SIGKILL'), 55000);
  let output;
  try {
    const port = await new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', data => {
        buffer += data;
        if (buffer.includes('\n')) resolve(Number(buffer.split('\n')[0]));
      });
      child.on('exit', code => reject(new Error(`bridge exited ${code}: ${stderr}`)));
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat`, {
      method: 'POST',
      headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'dsh:qq:group:200',
        message: 'Query current group via framework tools.',
        capabilities: { chat: true, web: false, files: false, terminal: false },
        framework: bridge.endpoint
      }),
      signal: AbortSignal.timeout(50000)
    });
    output = await response.text();
    if (failure) throw failure;
    assert.equal(response.status, 200, output);
    assert.ok(!output.includes('"type": "error"'), `${output}; ${stderr}`);
    if (twoTurns) {
      const second = await fetch(`http://127.0.0.1:${port}/v1/chat`, {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'dsh:qq:group:200',
          message: 'Recall your previous answer without another tool call.',
          capabilities: { chat: true, web: false, files: false, terminal: false },
          framework: bridge.endpoint
        }),
        signal: AbortSignal.timeout(50000)
      });
      const text = await second.text();
      if (failure) throw failure;
      assert.equal(second.status, 200, text);
      assert.ok(!text.includes('"type": "error"'), `${text}; ${stderr}`);
    }
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
  }

  if (failure) throw failure;
  assert.equal(executed, 1, `requests=${requests}; output=${output}; stderr=${stderr.slice(-3000)}`);
  assert.ok(output.includes('42'), output);
  console.log(`${exposeMode ? 'EXPOSE ' : ''}PASS: sandboxed installed DSH -> Python relay -> framework MCP -> receipt -> DSH answer (local model fixture).`);
} finally {
  bridge.close();
  if (exposeMode) disposeExpose('fixture-game');
  globalThis.__config = previousConfig;
  model.closeAllConnections();
  model.close();
  await rm(root, { recursive: true, force: true });
}
