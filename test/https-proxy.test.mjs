import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getGlobalDispatcher } from 'undici';
import { configureHttpsProxy, disposeHttpsProxy, validateHttpsProxy } from '../lib/network/https-proxy.js';

const proxyServer = async () => {
  const targets = [];
  const server = createServer();
  server.on('connect', (req, socket) => {
    targets.push(req.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, targets, url: `http://127.0.0.1:${server.address().port}` };
};

test('HTTPS_PROXY config and environment route native fetch through CONNECT, reload and bypass local hosts', async () => {
  const first = await proxyServer(), second = await proxyServer();
  const original = getGlobalDispatcher();
  const request = async url => assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
  try {
    configureHttpsProxy({}, { HTTPS_PROXY: first.url });
    await request('https://example.invalid/probe');
    assert.deepEqual(first.targets, ['example.invalid:443']);
    configureHttpsProxy({ HTTPS_PROXY: second.url }, { HTTPS_PROXY: first.url });
    await request('https://example.invalid/probe');
    assert.deepEqual(second.targets, ['example.invalid:443']);
    await request(`https://127.0.0.1:${first.server.address().port}/local`);
    assert.equal(second.targets.length, 1);
    configureHttpsProxy({ HTTPS_PROXY: second.url }, { NO_PROXY: 'example.invalid' });
    await request('https://example.invalid/probe');
    assert.equal(second.targets.length, 1);
    configureHttpsProxy({ HTTPS_PROXY: '' }, { HTTPS_PROXY: first.url });
    assert.equal(getGlobalDispatcher(), original);
  } finally {
    disposeHttpsProxy();
    first.server.closeAllConnections(); second.server.closeAllConnections();
    await Promise.all([new Promise(r => first.server.close(r)), new Promise(r => second.server.close(r))]);
  }
});

test('proxy validation rejects unsupported addresses without echoing credentials', () => {
  assert.equal(validateHttpsProxy(undefined), undefined);
  assert.equal(validateHttpsProxy(''), '');
  for (const value of ['socks5://localhost:7892', 'http://user:private@localhost', 'http://localhost/path', 'bad', 42]) {
    assert.throws(() => validateHttpsProxy(value), error => !error.message.includes('private') && /HTTPS_PROXY/.test(error.message));
  }
});
