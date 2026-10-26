// Real installed DSH + fake local model + real framework MCP. No paid requests or QQ writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { startFrameworkMcp } from '../lib/platform/mcp.js';
const root = await mkdtemp(join(tmpdir(), 'agent-link-mcp-runtime-'));
const python = resolve('.data/agent-link/venv/bin/python');
let executed = 0;
let requests = 0;
let failure;
const bridge = await startFrameworkMcp(
  [
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
  {
    platform: 'onebot',
    channelId: '200',
    userId: '100',
    private: false,
    owner: false,
    capabilities: { chat: true },
    signal: new AbortController().signal
  }
);
const model = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const names = (body.tools || []).map(tool => tool.function?.name);
    assert.ok(names.includes('mcp__framework__discover'), JSON.stringify(names));
    assert.ok(names.includes('mcp__framework__call'), JSON.stringify(names));
    const step = requests++;
    const choices = [
      ['mcp__framework__discover', {}],
      ['mcp__framework__discover', { name: 'fixture_group_info' }],
      ['mcp__framework__call', { name: 'fixture_group_info', argumentsJson: '{}' }]
    ];
    if (step === 3) assert.ok(JSON.stringify(body.messages).includes('42'));
    const message =
      step < 3
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `fixture-${step}`, type: 'function', function: { name: choices[step][0], arguments: JSON.stringify(choices[step][1]) } }]
          }
        : { role: 'assistant', content: '测试群有42人。' };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool, index) => ({ index, ...tool })) } : {}) };
      response.end(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: step < 3 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`
      );
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [{ index: 0, message, finish_reason: step < 3 ? 'tool_calls' : 'stop' }],
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
    assert.equal(response.status, 200, output);
    assert.ok(!output.includes('"type": "error"'), `${output}; ${stderr}`);
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
  }

  if (failure) throw failure;
  assert.equal(executed, 1, `requests=${requests}; output=${output}; stderr=${stderr.slice(-3000)}`);
  assert.ok(output.includes('42'), output);
  console.log('PASS: sandboxed installed DSH -> Python relay -> framework MCP -> receipt -> DSH answer (local model fixture).');
} finally {
  bridge.close();
  model.closeAllConnections();
  model.close();
  await rm(root, { recursive: true, force: true });
}
