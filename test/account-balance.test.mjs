import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalanceText } from '../lib/credentials/key-balance.js';
const response = (normal_wallets, bonus_wallets) => ({ code: 0, data: { biz_code: 0, biz_data: { normal_wallets, bonus_wallets } } });
test('account wallet sums preserve precision and separate currencies', () => {
  assert.equal(
    accountBalanceText(
      response(
        [
          { currency: 'CNY', balance: '0.1' },
          { currency: 'USD', balance: '1e+3' }
        ],
        [{ currency: 'CNY', balance: '.2' }]
      )
    ),
    '0.3 元 / 1000.00 美元'
  );
  assert.equal(accountBalanceText(response([{ currency: 'CNY', balance: '0E-16' }], [])), '0.00 元');
  assert.equal(
    accountBalanceText(response([{ currency: 'CNY', balance: '-1.' }], [{ currency: 'CNY', balance: '1.0000000000000001' }])),
    '0.0000000000000001 元'
  );
});
test('business errors and missing wallets never turn into zero balance', () => {
  assert.equal(accountBalanceText({ code: 40003 }), '查询失败，请稍后刷新');
  assert.equal(accountBalanceText({ code: 0, data: { biz_code: 1 } }), '查询失败，请稍后刷新');
  for (const value of [
    response([], []),
    response([], undefined),
    response([{ currency: 'EUR', balance: '10' }], []),
    response([{ currency: 'CNY', balance: 'NaN' }], []),
    response([{ currency: 'CNY', balance: '1e999999' }], [])
  ])
    assert.equal(accountBalanceText(value), '暂未取得余额');
});

test('account query uses platform grant header and hides network errors', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { encryptStoredKey } = await import('../lib/credentials/personal.js');
  const { storedKeyBalance } = await import('../lib/credentials/key-balance.js');
  const root = await mkdtemp(join(tmpdir(), 'account-balance-'));
  const oldKey = process.env.AGENT_LINK_PERSONAL_KEY_FILE;
  const oldFetch = globalThis.fetch;
  try {
    process.env.AGENT_LINK_PERSONAL_KEY_FILE = join(root, 'key');
    const record = { auth: 'account', enabled: true, revision: 'test', reason: '', encrypted: await encryptStoredKey('fixture', 'account-secret') };
    const scope = { platform: 'test', userId: 'u', channelId: 'private:["test","u"]' };
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://platform.deepseek.com/api/v0/users/get_user_summary');
      assert.deepEqual(init.headers, { 'x-dsh-auth-token': 'account-secret' });
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      return Response.json(response([{ currency: 'CNY', balance: '10' }], [{ currency: 'CNY', balance: '.5' }]));
    };
    assert.equal(await storedKeyBalance('fixture', scope, record), '10.5 元');
    globalThis.fetch = async () => {
      throw new Error('account-secret');
    };
    assert.equal(await storedKeyBalance('fixture', scope, record), '查询失败，请稍后刷新');
    assert.equal(record.enabled, true);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.AGENT_LINK_PERSONAL_KEY_FILE;
    else process.env.AGENT_LINK_PERSONAL_KEY_FILE = oldKey;
    await rm(root, { recursive: true, force: true });
  }
});
