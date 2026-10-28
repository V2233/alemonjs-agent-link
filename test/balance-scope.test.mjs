import test from 'node:test';
import assert from 'node:assert/strict';
import { withBudgetScope } from '../lib/billing/budget.js';
import { checkCredentialBalance } from '../lib/credentials/personal.js';

const scope = { platform: 'test', channelId: 'group', userId: 'one' };
const credential = { apiKey: 'sk-test', revision: 'one', scope };

test('one request reuses successful balance checks; independent requests and rotations check again', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ is_available: true });
  };
  const check = (value = credential) => checkCredentialBalance(value, assert.fail, async () => value);
  try {
    await withBudgetScope(scope, async () => {
      await check();
      await withBudgetScope(scope, check);
      assert.equal(calls, 1);
      await check({ ...credential, revision: 'two' });
      await check({ ...credential, scope: { ...scope, channelId: 'another-group' } });
      assert.equal(calls, 3);
    });
    await withBudgetScope(scope, check);
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test('cached confirmations still reject revoked credentials and cancellation', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ is_available: true });
  };
  try {
    await withBudgetScope(scope, async () => {
      await checkCredentialBalance(credential, assert.fail, async () => credential);
      await assert.rejects(
        checkCredentialBalance(credential, assert.fail, async () => null),
        /已变更/
      );
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(checkCredentialBalance(credential, assert.fail, async () => credential, controller.signal));
      assert.equal(calls, 1);
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('network errors are not cached or treated as insufficient balance', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('offline');
  };
  try {
    await withBudgetScope(scope, async () => {
      for (let i = 0; i < 2; i++)
        await assert.rejects(
          checkCredentialBalance(credential, assert.fail, async () => credential),
          /未切换/
        );
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});
