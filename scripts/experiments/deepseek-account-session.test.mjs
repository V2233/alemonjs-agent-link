import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validCallback, startSession } from './deepseek-account-session.mjs';
test('callback rejects wrong state, duplicate parameters and wrong methods', () => {
  assert.equal(validCallback('/oauth/callback?state=abc&code=x', 'abc'), true);
  for (const url of [
    '/oauth/callback?state=bad&code=x',
    '/oauth/callback?state=abc&code=x&code=y',
    '/oauth/callback?state=abc&state=abc&code=x',
    '/oauth/callback?state=abc',
    '/wrong?state=abc&code=x'
  ])
    assert.equal(validCallback(url, 'abc'), false);
  assert.equal(validCallback('/oauth/callback?state=abc&code=x', 'abc', 'POST'), false);
});
test('grant is queried then revoked without exposing token', async () => {
  let init;
  const paths = [];
  const request = async (url, options) => {
    const path = new URL(url).pathname;
    paths.push(path);
    let value = {};
    if (path.endsWith('auth_init')) {
      init = JSON.parse(options.body);
      value = { authorize_id: 'test', authorize_url: 'https://platform.deepseek.com/dsh/authorize', expires_in: 60 };
    }
    if (path.endsWith('auth_exchange')) value = { token: 'test-secret' };
    return Response.json({ code: 0, data: { biz_code: 0, biz_data: value } });
  };
  const session = await startSession({ request });
  try {
    const result = await fetch(`${init.redirect_uri}?state=${init.state}&code=test`);
    assert.equal(result.status, 200);
    assert.equal((await fetch(`${init.redirect_uri}?state=${init.state}&code=test`)).status, 410);
    assert.deepEqual(await session.verify(), { authorized: true, profileQuery: true, balanceQuery: true });
  } finally {
    await session.dispose();
  }
  assert.ok(paths.at(-1).endsWith('/logout'));
});
test('cancel resolves waiting verification and cancels remote task', async () => {
  const paths = [];
  const session = await startSession({
    request: async url => {
      paths.push(url);
      return Response.json({
        code: 0,
        data: { biz_code: 0, biz_data: { authorize_id: 'test', authorize_url: 'https://platform.deepseek.com/dsh/authorize', expires_in: 60 } }
      });
    }
  });
  const done = assert.rejects(session.verify(), /cancelled/);
  await session.dispose();
  await done;
  assert.ok(paths.at(-1).endsWith('auth_cancel'));
});
test('inference sends account header only to official API', async () => {
  let init;
  let inference;
  const request = async (url, options) => {
    if (url === 'https://api.deepseek.com/chat/completions') {
      inference = options;
      return Response.json({ choices: [{ message: { content: 'OK' } }] });
    }
    let value = {};
    if (url.endsWith('auth_init')) {
      init = JSON.parse(options.body);
      value = { authorize_id: 'test', authorize_url: 'https://platform.deepseek.com/dsh/authorize', expires_in: 60 };
    }
    if (url.endsWith('auth_exchange')) value = { token: 'test-secret' };
    return Response.json({ code: 0, data: { biz_code: 0, biz_data: value } });
  };
  const session = await startSession({ request });
  try {
    await fetch(`${init.redirect_uri}?state=${init.state}&code=test`);
    assert.equal((await session.verify({ model: 'deepseek-flash' })).inference, true);
    assert.equal(inference.headers['x-dsh-auth-token'], 'test-secret');
    assert.equal(inference.headers.Authorization, undefined);
    assert.equal(inference.redirect, 'error');
    assert.equal(JSON.parse(inference.body).max_tokens, 16);
  } finally {
    await session.dispose();
  }
});
test('credential ownership transfers only after successful storage', async () => {
  for (const fail of [false, true]) {
    let init;
    const paths = [];
    const session = await startSession({
      request: async (url, options) => {
        paths.push(url);
        let value = {};
        if (url.endsWith('auth_init')) {
          init = JSON.parse(options.body);
          value = { authorize_id: 'test', authorize_url: 'https://platform.deepseek.com/dsh/authorize', expires_in: 60 };
        }
        if (url.endsWith('auth_exchange')) value = { token: 'test-secret' };
        return Response.json({ code: 0, data: { biz_code: 0, biz_data: value } });
      }
    });
    await fetch(`${init.redirect_uri}?state=${init.state}&code=test`);
    const run = session.verify({
      onGrant: async token => {
        assert.equal(token, 'test-secret');
        if (fail) throw new Error('storage');
      }
    });
    if (fail) await assert.rejects(run, /storage/);
    else await run;
    await session.dispose();
    assert.equal(
      paths.some(p => p.endsWith('/logout')),
      fail
    );
    assert.equal(
      paths.some(p => p.endsWith('/auth_cancel')),
      false
    );
  }
});
