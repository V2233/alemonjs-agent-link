import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const packageRoot = process.env.AGENT_LINK_INTEGRATION_PACKAGE_ROOT || fileURLToPath(new URL('../', import.meta.url));
const { launchRuntime } = await import(pathToFileURL(join(packageRoot, 'runtime/runtime.mjs')).href);
const { acquireProcessLock } = await import(pathToFileURL(join(packageRoot, 'runtime/process-lock.mjs')).href);

test('real worker boots local app and an offline adapter, observes CBP readiness and reaps its child processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-link-worker-'));
  const frameworkPackage = createRequire(join(packageRoot, 'package.json')).resolve('alemonjs/package');
  const metadata = JSON.parse(await readFile(frameworkPackage, 'utf8'));
  const framework = pathToFileURL(resolve(dirname(frameworkPackage), metadata.exports['.'].import)).href;
  const adapter = join(root, 'adapter.mjs');
  await writeFile(
    adapter,
    `import { definePlatform, cbpPlatform } from ${JSON.stringify(framework)};
export default definePlatform({ main() { const cbp = cbpPlatform(); cbp.send({name:'connection.ready',Platform:'qq-bot',value:''}); } });`
  );
  const loader = join(root, 'loader.mjs');
  await writeFile(
    loader,
    `export async function resolve(specifier, context, next) {
if (specifier === '@alemonjs/qq-bot') return {url:${JSON.stringify(pathToFileURL(adapter).href)},shortCircuit:true};
return next(specifier,context); }`
  );
  const hook = join(root, 'hook.mjs');
  const pids = join(root, 'pids.txt');
  await writeFile(
    hook,
    `import {register} from 'node:module'; import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(pids)}, String(process.pid)+'\\n'); register(${JSON.stringify(pathToFileURL(loader).href)});`
  );
  const configPath = join(root, 'config.yaml');
  const dataRoot = join(root, 'data');
  await writeFile(configPath, 'alemonjs-agent-link:\n  apiKey: local-test-no-network\n  runtimeMode: chat-only\n  stateBackend: local\n');
  const owned = await acquireProcessLock(join(dataRoot, 'launcher.lock'));
  let unlock;
  const unlocked = new Promise(resolve => {
    unlock = resolve;
  });
  let worker;
  const output = [];
  const previous = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = `${previous || ''} --import=${pathToFileURL(hook).href}`.trim();
    await launchRuntime({
      cwd: root,
      configPath,
      dataRoot,
      runtimeRoot: dataRoot,
      write: text => output.push(text),
      timeoutMs: 15000,
      ownership: {
        async release() {
          await owned.release();
          unlock();
        }
      },
      spawnWorker: (...args) => {
        worker = fork(...args);
        return worker;
      }
    });
    assert.match(output.join(''), /机器人已在线/);
    const status = JSON.parse(await readFile(join(dataRoot, 'startup-status.json'), 'utf8'));
    assert.equal(status.chatReady, true);
  } catch (error) {
    let diagnostics = '';
    try {
      diagnostics = await readFile(join(dataRoot, 'startup.log'), 'utf8');
    } catch {}
    throw new Error(`${error.message}\n${diagnostics}`);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    if (worker && worker.exitCode === null) {
      worker.kill('SIGTERM');
      await new Promise(resolve => worker.once('close', resolve));
    }
    await unlocked;
  }
  const processIds = [...new Set((await readFile(pids, 'utf8')).trim().split('\n').map(Number))];
  assert.ok(processIds.length >= 3);
  for (const pid of processIds)
    assert.throws(
      () => process.kill(pid, 0),
      error => error.code === 'ESRCH'
    );
});
