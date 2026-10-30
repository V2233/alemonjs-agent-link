import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCLI, diagnose, inspectConfig } from '../runtime/startup.mjs';

const temporary = () => mkdtemp(join(tmpdir(), 'agent-link-cli-'));
const valid = "qq-bot:\n  app_id: '1234'\n  secret: 'secret-do-not-print'\nalemonjs-agent-link:\n  apiKey: 'api-key-do-not-print'\n";
const run = async (cwd, args = []) => {
  const output = [];
  const starts = [];
  const code = await runCLI(args, { cwd, homeDir: join(cwd, 'profile'), write: line => output.push(line), start: value => starts.push(value) });
  return { code, output: output.join('\n'), starts };
};

test('first launch creates a private minimal config and starts only after credentials are filled', async () => {
  const cwd = await temporary();
  const configPath = join(cwd, 'profile', 'alemon.config.yaml');
  const first = await run(cwd);
  assert.equal(first.code, 2);
  assert.equal(first.starts.length, 0);
  assert.match(first.output, /已生成最小配置/);
  const generated = await readFile(configPath, 'utf8');
  assert.match(generated, /apiKey: ''/);
  assert.doesNotMatch(generated, /redis|python|runtimeMode/i);
  if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o077, 0);
  assert.match((await run(cwd)).output, /apiKey/);
  await writeFile(configPath, valid);
  const configured = await run(cwd);
  assert.equal(configured.code, 0);
  assert.deepEqual(configured.starts, [{ cwd, configPath, dataRoot: join(cwd, 'profile', 'data') }]);
  assert.equal(configured.output, '');
  assert.equal(await readFile(configPath, 'utf8'), valid);
});

test('doctor never creates files or starts services and emits secret-free JSON', async () => {
  const cwd = await temporary();
  const missing = await run(cwd, ['doctor']);
  assert.equal(missing.code, 1);
  await assert.rejects(access(join(cwd, 'profile', 'alemon.config.yaml')));
  await mkdir(join(cwd, 'profile'), { recursive: true });
  await writeFile(join(cwd, 'profile', 'alemon.config.yaml'), valid);
  const result = await run(cwd, ['doctor', '--json']);
  assert.equal(result.starts.length, 0);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.output).ok, true);
  assert.doesNotMatch(result.output, /secret-do-not-print|api-key-do-not-print/);
  await assert.rejects(access(join(cwd, '.data')));
});

test('malformed and duplicate YAML never echo source secrets or overwrite user config', async () => {
  const cwd = await temporary();
  for (const contents of ["secret: 'do-not-print-[\n", 'secret: do-not-print\nsecret: again\n']) {
    const path = join(cwd, 'profile', 'alemon.config.yaml');
    await mkdir(join(cwd, 'profile'), { recursive: true });
    await writeFile(path, contents);
    const result = await run(cwd);
    assert.equal(result.code, 2);
    assert.equal(result.starts.length, 0);
    assert.match(result.output, /YAML/);
    assert.doesNotMatch(result.output, /do-not-print/);
    assert.equal(await readFile(path, 'utf8'), contents);
  }
});

test('custom config path, idempotent init and invalid arguments are handled', async () => {
  const cwd = await temporary();
  const args = ['init', '--config', 'settings/bot.yaml'];
  assert.equal((await run(cwd, args)).code, 0);
  const path = join(cwd, 'settings', 'bot.yaml');
  await writeFile(path, valid);
  assert.equal((await run(cwd, args)).code, 0);
  assert.equal(await readFile(path, 'utf8'), valid);
  assert.equal((await run(cwd, ['start', '--config'])).code, 2);
  assert.equal((await run(cwd, ['--help'])).code, 0);
});

test('placeholder, invalid credential types and model URLs are actionable', () => {
  const config = { 'qq-bot': { app_id: '<APP_ID>', secret: 123 }, 'alemonjs-agent-link': { apiKey: 123, baseUrl: 'http://user:password@example.com' } };
  const checks = inspectConfig(config);
  assert.equal(checks.filter(item => item.status === 'error').length, 4);
  assert.doesNotMatch(JSON.stringify(checks), /password@example|<APP_ID>/);
});

test('data path that is a file fails offline preflight', async () => {
  const cwd = await temporary();
  const configPath = join(cwd, 'bot.yaml');
  const data = join(cwd, 'not-directory');
  await writeFile(data, 'file');
  await writeFile(configPath, valid.replace('  apiKey:', `  dshHomeRoot: '${data}/homes'\n  apiKey:`));
  const report = await diagnose({ cwd, configPath });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.name === 'data').status, 'error');
});

test('CLI executable works from an empty directory without importing the bot framework', async () => {
  const cwd = await temporary();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../runtime/agent-link.mjs', import.meta.url)), 'doctor', '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, AGENT_LINK_HOME: join(cwd, 'profile') }
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /\[logger\]|initialized|Shutting down Redis/);
});

test('existing namespaced QQ and multi-bot configurations stay supported', () => {
  const agent = { apiKey: 'configured' };
  assert.equal(
    inspectConfig({ '@alemonjs/qq-bot': { app_id: '123', secret: 'configured' }, 'alemonjs-agent-link': agent }).filter(item => item.status === 'error').length,
    0
  );
  assert.equal(
    inspectConfig({ 'qq-bot': { bots: { 123: { secret: 'configured' } } }, 'alemonjs-agent-link': agent }).filter(item => item.status === 'error').length,
    0
  );
  assert.equal(
    inspectConfig({ 'qq-bot': { bots: { 123: { secret: 'configured' }, 456: { secret: 'configured' } } }, 'alemonjs-agent-link': agent }).filter(
      item => item.status === 'error'
    ).length,
    1
  );
});

test('QR login accepts an absent QQ account but rejects partial manually entered credentials', async () => {
  assert.equal(
    inspectConfig({ 'alemonjs-agent-link': { apiKey: 'configured' } }).some(item => item.status === 'error'),
    false
  );
  assert.equal(
    inspectConfig({ 'qq-bot': { app_id: '123' }, 'alemonjs-agent-link': { apiKey: 'configured' } }).some(item => item.status === 'error'),
    true
  );
});

test('offline validation and runtime reject the same invalid settings', async () => {
  const { resolveDSHConfig } = await import('../lib/dsh/config.js');
  for (const patch of [
    { bridgePort: 80 },
    { dshHomeRoot: '' },
    { workspaceRoot: ' ' },
    { maxConcurrentRequests: 0 },
    { pythonPackageSources: ['http://example.invalid/simple'] },
    { groupChat: { maxPerHour: -1 } }
  ]) {
    const value = { 'alemonjs-agent-link': { apiKey: 'configured', ...patch } };
    assert.throws(() => resolveDSHConfig(value['alemonjs-agent-link']));
    assert.equal(
      inspectConfig(value).some(item => item.status === 'error'),
      true
    );
  }
});

test('default profile is stable across working directories and remembers a legacy profile', async () => {
  const { launchPaths } = await import('../runtime/paths.mjs');
  const root = await temporary();
  const homeDir = join(root, 'user-profile');
  const left = join(root, 'left');
  const right = join(root, 'right');
  await mkdir(left);
  await mkdir(right);
  assert.equal((await launchPaths({ cwd: left, homeDir })).configPath, (await launchPaths({ cwd: right, homeDir })).configPath);
  const legacy = join(left, 'alemon.config.yaml');
  await writeFile(legacy, valid);
  const starts = [];
  assert.equal(await runCLI([], { cwd: left, homeDir, write() {}, start: value => starts.push(value) }), 0);
  const fromElsewhere = await launchPaths({ cwd: right, homeDir });
  assert.equal(fromElsewhere.configPath, legacy);
  assert.equal(fromElsewhere.dataRoot, join(left, '.data', 'agent-link'));
  assert.equal((await launchPaths({ cwd: right, homeDir, portable: true })).configPath, join(right, 'alemon.config.yaml'));
});

test('outer instance lock prevents starting a second adapter', async () => {
  const { acquireProcessLock } = await import('../runtime/process-lock.mjs');
  const cwd = await temporary();
  const homeDir = join(cwd, 'profile');
  await mkdir(homeDir);
  await writeFile(join(homeDir, 'alemon.config.yaml'), valid);
  const lock = await acquireProcessLock(join(homeDir, 'data', 'launcher.lock'));
  try {
    let starts = 0;
    const output = [];
    const code = await runCLI([], {
      cwd,
      homeDir,
      write: text => output.push(text),
      start() {
        starts++;
      }
    });
    assert.equal(code, 1);
    assert.equal(starts, 0);
    assert.match(output.join(''), /已在运行/);
  } finally {
    await lock.release();
  }
});

test('the declared minimum Node boundary is checked before setup', async () => {
  const { supportsNodeVersion } = await import('../runtime/startup.mjs');
  assert.equal(supportsNodeVersion('20.19.0'), false);
  assert.equal(supportsNodeVersion('22.12.0'), false);
  assert.equal(supportsNodeVersion('22.13.0'), true);
  assert.equal(supportsNodeVersion('24.0.0'), true);
});
