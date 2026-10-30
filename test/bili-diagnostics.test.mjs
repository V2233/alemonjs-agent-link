import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFfmpeg, inspectBiliReadiness } from '../lib/panel/bili-diagnostics.js';
import { resolveDSHConfig } from '../lib/dsh/config.js';
import { getMediaConfig } from '../lib/media/config.js';

test('readiness checks current settings without treating configured credentials as network proof', async () => {
  const config = resolveDSHConfig({ modules: { settings: { bili: { visualRead: true, audioRead: true, cookie: 'SESSDATA=private-cookie' } } } });
  const media = getMediaConfig({ media: { vision: { baseUrl: 'https://private-vision.example/v1', apiKey: 'private-key', model: 'test' }, asr: { baseUrl: 'http://127.0.0.1:12001/v1', model: 'test-local' } } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('diagnostics must not access the network');
  };
  try {
    const report = await inspectBiliReadiness(
      () => config,
      () => media,
      async () => true
    );
    assert.equal(report.scope, 'local_only');
    assert.ok(report.checks.every(check => check.state === 'ready'));
    assert.match(report.checks.find(check => check.id === 'cookie').detail, /未验证/);
    assert.match(report.checks.find(check => check.id === 'vision').detail, /未调用模型/);
    assert.ok(!/private-cookie|private-key|private-vision/.test(JSON.stringify(report)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('diagnostics show disabled and missing dependencies and continue through malformed settings', async () => {
  const report = await inspectBiliReadiness(
    () => resolveDSHConfig({ modules: { disabled: ['bili'] } }),
    () => getMediaConfig({}),
    async () => false
  );
  const states = Object.fromEntries(report.checks.map(check => [check.id, check.state]));
  assert.deepEqual(states, { module: 'disabled', visual: 'disabled', cookie: 'missing', vision: 'missing', audio: 'disabled', ffmpeg: 'missing' });
  const failed = await inspectBiliReadiness(
    () => {
      throw new Error('private-configuration');
    },
    () => {
      throw new Error('private-provider');
    },
    async () => {
      throw new Error('private-path');
    }
  );
  assert.equal(failed.checks.length, 4);
  assert.deepEqual(
    failed.checks.map(check => check.state),
    ['invalid', 'invalid', 'invalid', 'missing']
  );
  assert.ok(!JSON.stringify(failed).includes('private-'));
});

test('ffmpeg check runs a fixed local command with bounded output and time', async () => {
  assert.equal(
    await checkFfmpeg(async (command, args, options) => {
      assert.equal(command, 'ffmpeg');
      assert.deepEqual(args, ['-version']);
      assert.equal(options.timeout, 3000);
      assert.equal(options.maxBuffer, 16 * 1024);
      assert.equal(options.killSignal, 'SIGKILL');
      return { stdout: 'ffmpeg version 7.1 test' };
    }),
    true
  );
  assert.equal(await checkFfmpeg(async () => ({ stdout: 'unexpected executable' })), false);
  assert.equal(
    await checkFfmpeg(async () => {
      throw new Error('ENOENT private-path');
    }),
    false
  );
});

test('enabled video transcription diagnostics distinguish missing and unsupported ASR without exposing service data', async () => {
  const config = resolveDSHConfig({ modules: { settings: { bili: { audioRead: true } } } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('diagnostics must not connect to ASR');
  try {
    for (const [asr, expected] of [[undefined, 'missing'], [{ baseUrl: 'https://private-asr.example/v1', apiKey: 'private-asr-key', model: 'private-model' }, 'invalid']]) {
      const report = await inspectBiliReadiness(() => config, () => getMediaConfig({ media: { asr } }), async () => false);
      assert.equal(report.checks.find(check => check.id === 'audio').state, expected);
      assert.ok(!JSON.stringify(report).includes('private-'));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('admin HTTP diagnostics return a safe local-only report without requiring a config write', async () => {
  const { default: Koa } = await import('koa');
  const { default: router } = await import('../lib/api-router.js');
  const previous = globalThis.__config;
  globalThis.__config = { value: { 'alemonjs-agent-link': { modules: { settings: { bili: { cookie: 'private-cookie' } } } } } };
  const app = new Koa();
  app.use(router.routes());
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/hobbies/diagnostics`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.data.scope, 'local_only');
    assert.ok(body.data.checks.some(check => check.id === 'ffmpeg'));
    assert.ok(!JSON.stringify(body).includes('private-cookie'));
    assert.equal(globalThis.__config.value['alemonjs-agent-link'].modules.settings.bili.cookie, 'private-cookie');
  } finally {
    globalThis.__config = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
