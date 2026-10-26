import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchRuntime } from '../bin/runtime.mjs';
import { redact, appendDiagnostic } from '../bin/diagnostics.mjs';
const frame = event => ({ type: 'cbp.event', data: { protocol: 'cbp', type: 'event', payload: { event } } });
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-link-runtime-'));
  const configPath = join(root, 'config.yaml');
  await writeFile(configPath, 'alemonjs-agent-link:\n  apiKey: test-api-secret\nqq-bot:\n  secret: qq-secret\n');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    queueMicrotask(() => {
      child.exitCode = 0;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return true;
  };
  let released = 0;
  const output = [];
  const options = {
    cwd: root,
    configPath,
    dataRoot: root,
    runtimeRoot: root,
    write: text => output.push(text),
    ownership: {
      async release() {
        released++;
      }
    },
    spawnWorker: () => child,
    timeoutMs: 1000
  };
  return { options, child, output, root, released: () => released };
};

test('readiness requires QQ plus app plus chat runtime, and shutdown releases ownership', async () => {
  const f = await fixture();
  let ready = false;
  const running = launchRuntime(f.options).then(() => {
    ready = true;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  f.child.emit('message', { type: 'agent-link.state', module: 'app_ready', phase: 'preparing', chatReady: true });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ready, false);
  f.child.emit('message', frame({ name: 'connection.ready' }));
  await running;
  assert.equal(ready, true);
  assert.match(f.output.join(''), /模型连接以实际回复/);
  f.child.kill();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.released(), 1);
});

test('failed runtime never reports ready and waits for child shutdown before releasing lock', async () => {
  const f = await fixture();
  const pending = launchRuntime(f.options);
  await new Promise(resolve => setTimeout(resolve, 20));
  f.child.emit('message', { type: 'agent-link.state', module: 'failed', chatReady: false });
  await assert.rejects(pending);
  assert.equal(f.released(), 1);
  assert.equal(
    f.output.some(line => line.includes('机器人已在线')),
    false
  );
});

test('startup diagnostics hide configured secrets and redact bearer and URL credentials', async () => {
  const f = await fixture();
  const path = join(f.root, 'startup.log');
  appendDiagnostic(path, 'test-api-secret qq-secret Authorization: Bearer abc123 https://u:p@example.invalid?token=secret', f.options.configPath);
  const text = await readFile(path, 'utf8');
  assert.doesNotMatch(text, /test-api-secret|qq-secret|abc123|u:p@|token=secret/);
  assert.match(redact('Bearer private'), /已隐藏/);
});

test('QR lifecycle frames render a terminal code and do not claim connected before the actual ready event', async () => {
  const f = await fixture();
  const pending = launchRuntime(f.options);
  await new Promise(resolve => setTimeout(resolve, 20));
  f.child.emit('message', frame({ name: 'login.qrcode', QRCode: { url: 'https://example.invalid/authorize?task=test' } }));
  f.child.emit('message', frame({ name: 'login.success' }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(f.output.join(''), /手机 QQ 扫码/);
  assert.match(f.output.join(''), /授权已保存/);
  assert.equal(
    f.output.some(line => line.includes('机器人已在线')),
    false
  );
  f.child.emit('message', { type: 'agent-link.state', module: 'app_ready', phase: 'degraded', chatReady: true });
  f.child.emit('message', frame({ name: 'connection.ready' }));
  await pending;
  f.child.kill();
  await new Promise(resolve => setTimeout(resolve, 10));
});

test('connection timeout stops worker, reports an actionable log path and releases ownership', async () => {
  const f = await fixture();
  await assert.rejects(launchRuntime({ ...f.options, timeoutMs: 30 }), error => error.code === 'ERUNTIME_TIMEOUT' && error.logPath.endsWith('startup.log'));
  assert.equal(f.released(), 1);
  assert.match(f.output.join(''), /诊断日志/);
});
