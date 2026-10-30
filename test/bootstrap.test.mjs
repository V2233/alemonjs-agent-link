import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePython, runQuiet } from '../lib/dsh/python-bootstrap.js';
import { DSHSupervisor } from '../lib/dsh/supervisor.js';
import { getDSHConfig } from '../lib/dsh/client.js';

const configFor = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-link-bootstrap-'));
  return getDSHConfig({
    dshHomeRoot: join(root, 'homes'),
    pythonExecutable: join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    pythonPackageSources: ['https://first.example/simple', 'https://second.example/simple']
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
  supervisor.bootstrapPython = async () => {
    throw new Error('managed download unavailable');
  };
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
  const config = getDSHConfig({ dshHomeRoot: join(root, 'homes') });
  assert.equal(config.pythonExecutable, join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  assert.equal(getDSHConfig({ dshHomeRoot: join(root, 'homes'), pythonExecutable: '/custom/python' }).pythonExecutable, '/custom/python');
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

test('rapid status transitions persist the latest phase and cancellation cannot write an old ready record', async () => {
  const config = await configFor();
  const supervisor = new DSHSupervisor(config, { apiKey: 'test' }, 'status-order');
  supervisor.statusValue = { phase: 'installing' };
  const installing = supervisor.writeStartupStatus();
  supervisor.statusValue = { phase: 'ready' };
  const ready = supervisor.writeStartupStatus();
  await Promise.all([installing, ready]);
  const path = join(config.dshHomeRoot, '..', 'startup-status.json');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).phase, 'ready');
  const stale = supervisor.writeStartupStatus();
  supervisor.stop();
  await stale;
  await supervisor.writeStartupStatus();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).phase, 'stopped');
});

test('bubblewrap setup never prompts and tries another package manager on failure', async () => {
  const { installBubblewrap } = await import('../lib/dsh/sandbox-bootstrap.js');
  const calls = [];
  await installBubblewrap(1000, undefined, async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw new Error('unavailable');
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][5].DEBIAN_FRONTEND, 'noninteractive');
  if (process.getuid?.() !== 0) assert.equal(calls[0][1][0], '-n');
});

test('managed Python rejects a corrupt download before extracting or executing', async () => {
  const { installManagedPython } = await import('../lib/dsh/managed-python.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-link-managed-'));
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('invalid archive');
  try {
    await assert.rejects(
      installManagedPython(root, async () => assert.fail('must not execute')),
      /checksum/
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test('missing system Python uses private uv and verifies the SDK after installation', async () => {
  const config = await configFor();
  const tools = join(config.dshHomeRoot, '..', 'tools');
  await mkdir(tools, { recursive: true });
  await writeFile(join(tools, 'uv-0.13.6'), 'test fixture');
  const calls = [];
  let probes = 0;
  await preparePython(
    config,
    'requirements.txt',
    () => {},
    async (command, args, ...rest) => {
      calls.push([command, args, ...rest]);
      if (command === 'python' || command === 'python3' || args[0] === '-I') throw new Error('missing');
      if (args[0] === '-c' && probes++ === 0) throw new Error('missing');
    }
  );
  const uv = calls.find(([command, args]) => command.endsWith('uv-0.13.6') && args[0] === 'venv');
  assert.ok(uv);
  assert.ok(uv[1].includes('--managed-python'));
  assert.ok(uv[1].includes('3.12'));
  assert.equal(uv[5].UV_PYTHON_INSTALL_DIR, join(config.dshHomeRoot, '..', 'python'));
  assert.equal(probes, 2);
});

test('platform preflight explains unsupported environments before installing', async () => {
  const { agentPlatformIssue } = await import('../lib/dsh/platform-preflight.js');
  assert.match(agentPlatformIssue('win32', 'x64', '10', undefined), /wsl --install/);
  assert.match(agentPlatformIssue('darwin', 'arm64', '22.6', undefined), /macOS 14/);
  assert.equal(agentPlatformIssue('darwin', 'arm64', '23.0', undefined), undefined);
  assert.match(agentPlatformIssue('linux', 'x64', '6.0', ''), /musl/);
  assert.match(agentPlatformIssue('linux', 'x64', '6.0', '2.27'), /glibc/);
  assert.equal(agentPlatformIssue('linux', 'x64', '6.0', '2.28'), undefined);
  assert.match(agentPlatformIssue('linux', 'ia32', '6.0', '2.39'), /架构/);
});

test('large SDK download uses preparation budget and reserves time for another source', async () => {
  const config = await configFor();
  config.preparationTimeoutMs = 120000;
  config.startupTimeoutMs = 1000;
  const budgets = [];
  let probeCount = 0;
  await preparePython(
    config,
    'requirements.txt',
    () => {},
    async (_command, args, timeout) => {
      if (args[0] === '-c' && probeCount++ === 0) throw new Error('missing');
      if (args.includes('--index-url')) {
        budgets.push(timeout);
        if (budgets.length === 1) throw new Error('source offline');
      }
    }
  );
  assert.equal(budgets.length, 2);
  assert.ok(budgets[0] > config.startupTimeoutMs);
  assert.ok(budgets[0] <= 60000);
  assert.ok(budgets[1] > budgets[0]);
});

test('SDK download retry reuses a healthy venv instead of recreating it', async () => {
  const config = await configFor();
  const calls = [];
  let probeCount = 0;
  await preparePython(
    config,
    'requirements.txt',
    () => {},
    async (command, args) => {
      calls.push([command, args]);
      if (args[0] === '-c' && probeCount++ === 0) throw new Error('SDK not installed');
    }
  );
  assert.ok(calls.some(([, args]) => args[0] === '-I' && args.includes('-c')));
  assert.ok(calls.some(([, args]) => args.includes('--requirement')));
  assert.ok(!calls.some(([, args]) => args.includes('venv')));
  assert.ok(!calls.some(([command]) => command === 'python3' || command === 'python'));
});

test('old system Python is rejected before creating a venv', async () => {
  const config = await configFor();
  let environmentReady = false;
  let sdkReady = false;
  const calls = [];
  await preparePython(
    config,
    'requirements.txt',
    () => {},
    async (command, args) => {
      calls.push([command, args]);
      if (command === 'python3') throw new Error('Python too old');
      if (args[0] === '-c' && !sdkReady) throw new Error('missing SDK');
      if (command === config.pythonExecutable && args[0] === '-I' && !environmentReady) throw new Error('missing venv');
      if (command === 'python' && args.includes('venv')) environmentReady = true;
      if (args.includes('--requirement')) sdkReady = true;
    }
  );
  assert.ok(!calls.some(([command, args]) => command === 'python3' && args.includes('venv')));
  assert.ok(calls.some(([command, args]) => command === 'python' && args.includes('venv')));
});

test('concurrent Python setup cannot mutate the same environment and releases its lock', async () => {
  const config = await configFor();
  let entered;
  let finish;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    finish = resolve;
  });
  const first = preparePython(
    config,
    'requirements.txt',
    () => {},
    async () => {
      entered();
      await gate;
    }
  );
  await started;
  try {
    await assert.rejects(
      preparePython(
        config,
        'requirements.txt',
        () => {},
        async () => assert.fail('concurrent runner')
      ),
      { code: 'ELOCKED' }
    );
  } finally {
    finish();
    await first;
  }
  await preparePython(
    config,
    'requirements.txt',
    () => {},
    async () => {}
  );
});

test('cancelled installation kills descendant processes on POSIX', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-installer-tree-'));
  const heartbeat = join(root, 'heartbeat');
  const descendant = `const fs=require('node:fs'); setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const pending = runQuiet(process.execPath, ['-e', parent], 5000, controller.signal);
  const rejected = assert.rejects(pending, /abort/i);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        await readFile(heartbeat);
        ready = true;
        break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(ready, true);
  } finally {
    controller.abort();
    await rejected;
  }
  const stopped = await readFile(heartbeat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await readFile(heartbeat, 'utf8'), stopped);
});
