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
