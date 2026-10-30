// Run the full suite against a disposable, socket-only Redis. No deployment config is read.
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.env.AGENT_LINK_TEST_REDIS_SERVER || 'redis-server';
const root = await mkdtemp(join(tmpdir(), 'agent-link-redis-test-'));
const socket = join(root, 'redis.sock');
const config = join(root, 'test.yaml');
let server, suite;
let startupError;
let stopped = false;
const interrupt = () => { stopped = true; suite?.kill('SIGTERM'); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  server = spawn(binary, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  server.on('error', error => { startupError = error; });
  const exited = once(server, 'exit').catch(() => {});
  let ready = false;
  for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
    if (startupError) throw startupError;
    if (server.exitCode !== null || server.signalCode) throw new Error('Test Redis exited before becoming ready.');
    try { await access(socket); ready = true; break; } catch { await delay(50); }
  }
  if (!ready) throw new Error('Test Redis did not become ready.');
  await writeFile(config, JSON.stringify({ db: { redis: { path: socket } } }), { mode: 0o600 });
  const files = process.argv.slice(2);
  suite = spawn(files.length ? process.execPath : 'npm', files.length ? ['--test', '--test-force-exit', ...files] : ['test'], {
    cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit',
    env: { ...process.env, AGENT_LINK_TEST_REDIS_SERVER: binary, AGENT_LINK_TEST_REDIS_CONFIG: config }
  });
  const result = await Promise.race([
    once(suite, 'exit').then(([code]) => code ?? 1),
    exited.then(() => { suite.kill('SIGTERM'); throw new Error('Test Redis stopped during the suite.'); })
  ]);
  process.exitCode = stopped ? 130 : result;
} catch (error) {
  console.error(`Redis test run failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null && !server.signalCode && !startupError) {
    const exited = once(server, 'exit').catch(() => {});
    server.kill('SIGTERM');
    await exited;
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  await rm(root, { recursive: true, force: true });
}
