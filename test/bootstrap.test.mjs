import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePython, runQuiet } from '../lib/dsh/python-bootstrap.js';
import { DSHSupervisor } from '../lib/dsh/supervisor.js';
import { getDSHConfig } from '../lib/dsh/client.js';

const configFor = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-link-bootstrap-'));
  return getDSHConfig({
    'alemonjs-agent-link': {
      dshHomeRoot: join(root, 'homes'),
      pythonExecutable: join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      pythonPackageSources: ['https://first.example/simple', 'https://second.example/simple']
    }
  });
};

test('ready Python does not install or contact a source', async () => {
  const config = await configFor();
  const calls = [];
  await preparePython(
    config,
    'requirements.txt',
    () => assert.fail('unexpected install'),
    async (...args) => {
      calls.push(args);
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][0], '-c');
});

test('failed source switches, verifies installation and remembers successful source', async () => {
  const config = await configFor();
  const sources = [];
  let probe = 0;
  const runner = async (_command, args) => {
    if (args[0] === '-c' && probe++ === 0) throw new Error('missing SDK');
    if (args.includes('--index-url')) {
      const source = args[args.indexOf('--index-url') + 1];
      sources.push(source);
      if (source.includes('first')) throw new Error('offline');
    }
  };
  await preparePython(config, 'requirements.txt', () => {}, runner);
  assert.deepEqual(sources, config.pythonPackageSources);
  assert.equal(JSON.parse(await readFile(join(config.dshHomeRoot, '..', 'python-source.json'), 'utf8')).source, sources[1]);
  sources.length = 0;
  probe = 0;
  await preparePython(config, 'requirements.txt', () => {}, runner);
  assert.deepEqual(sources, [config.pythonPackageSources[1]]);
});

test('custom Python is never overwritten and child processes have a deadline', async () => {
  const config = await configFor();
  config.pythonExecutable = '/custom/python';
  let calls = 0;
  await assert.rejects(
    preparePython(
      config,
      'requirements.txt',
      () => {},
      async () => {
        calls++;
        throw new Error('missing');
      }
    ),
    /Configured Python/
  );
  assert.equal(calls, 1);
  await assert.rejects(runQuiet(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100), /timed out/);
  await assert.rejects(runQuiet('agent-link-nonexistent-command', [], 1000));
});

test('chat-only starts without Python or credentials and records a safe status', async () => {
  const config = await configFor();
  config.runtimeMode = 'chat-only';
  const supervisor = new DSHSupervisor(config, null, 'test');
  await supervisor.start();
  assert.equal(supervisor.status().phase, 'degraded');
  const status = JSON.parse(await readFile(join(config.dshHomeRoot, '..', 'startup-status.json'), 'utf8'));
  assert.equal(status.phase, 'degraded');
  assert.match(status.detail, /apiKey/);
  assert.equal(status.arch, process.arch);
  supervisor.stop();
});

test('auto mode remains usable with no Python or sandbox commands on PATH', async () => {
  const config = await configFor();
  const previous = process.env.PATH;
  const supervisor = new DSHSupervisor(config, { apiKey: 'local-test-only' }, 'no-dependencies');
  try {
    process.env.PATH = '';
    await supervisor.start();
    assert.equal(supervisor.status().phase, 'degraded');
  } finally {
    process.env.PATH = previous;
    supervisor.stop();
  }
});

test('moving the data root also moves managed Python without extra configuration', () => {
  const root = join(tmpdir(), 'agent-link-relocated');
  const config = getDSHConfig({ 'alemonjs-agent-link': { dshHomeRoot: join(root, 'homes') } });
  assert.equal(config.pythonExecutable, join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  assert.equal(
    getDSHConfig({ 'alemonjs-agent-link': { dshHomeRoot: join(root, 'homes'), pythonExecutable: '/custom/python' } }).pythonExecutable,
    '/custom/python'
  );
});

test('stop cancels preparation and cannot be overwritten by a late successful launch', async () => {
  const config = await configFor();
  const supervisor = new DSHSupervisor(config, { apiKey: 'test' }, 'stop-race');
  let complete;
  let entered;
  const launching = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    complete = resolve;
  });
  supervisor.launch = async signal => {
    entered();
    await gate;
    assert.equal(signal.aborted, true);
  };
  const pending = supervisor.start();
  await launching;
  supervisor.stop();
  complete();
  await pending;
  assert.equal(supervisor.status().phase, 'stopped');
  assert.equal(supervisor.status().chatReady, false);
});

test('chat is available while optional preparation runs and conversations retain their backend until reset', async () => {
  const config = await configFor();
  const supervisor = new DSHSupervisor(config, { apiKey: 'test' }, 'nonblocking');
  let complete;
  const gate = new Promise(resolve => {
    complete = resolve;
  });
  supervisor.launch = async () => {
    await gate;
  };
  await supervisor.prepareForChat();
  assert.equal(supervisor.status().chatReady, true);
  assert.equal(supervisor.useSandbox('session:v1'), false);
  complete();
  await supervisor.start();
  assert.equal(supervisor.status().phase, 'ready');
  assert.equal(supervisor.useSandbox('session:v1'), false);
  supervisor.resetTransport('session');
  assert.equal(supervisor.useSandbox('session:v2'), true);
  supervisor.stop();
});

test('cancellation kills a running preparation child promptly', async () => {
  const controller = new AbortController();
  const pending = runQuiet(process.execPath, ['-e', 'setInterval(() => {},1000)'], 10000, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, error => error?.name === 'AbortError');
});

test('automatic port selection avoids an occupied fixed port', async () => {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = await configFor();
  const supervisor = new DSHSupervisor(config, { apiKey: 'test' }, 'port');
  try {
    assert.notEqual(await supervisor.choosePort(), server.address().port);
  } finally {
    server.close();
    supervisor.stop();
  }
});

test('pending session resets must succeed before optional sandbox can expose old history', async () => {
  const config = await configFor();
  const supervisor = new DSHSupervisor(config, { apiKey: 'test' }, 'deferred-reset');
  const original = globalThis.fetch;
  let calls = 0;
  try {
    supervisor.queueSessionReset('session');
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.equal(options.method, 'DELETE');
      return new Response(null, { status: 503 });
    };
    await assert.rejects(supervisor.flushSessionResets(new AbortController().signal));
    globalThis.fetch = async () => {
      calls++;
      return new Response(null, { status: 204 });
    };
    await supervisor.flushSessionResets(new AbortController().signal);
    await supervisor.flushSessionResets(new AbortController().signal);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    supervisor.stop();
  }
});
