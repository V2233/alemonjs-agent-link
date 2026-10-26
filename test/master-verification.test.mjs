import assert from 'node:assert/strict';
import test from 'node:test';
import { MasterVerification } from '../lib/state/master-verification.js';

test('master codes are identity-bound and single-use', () => {
  const cache = new MasterVerification();
  const code = cache.issue('platform:user', 0);
  assert.match(code, /^\d{6}$/);
  assert.equal(cache.verify('other:user', code, 1), false);
  assert.equal(cache.verify('platform:user', code, 1), true);
  assert.equal(cache.verify('platform:user', code, 2), false);
});

test('codes expire after five minutes and after five failed attempts', () => {
  const cache = new MasterVerification();
  const expired = cache.issue('expired', 0);
  assert.equal(cache.verify('expired', expired, 300000), false);
  const code = cache.issue('attempts', 0);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(cache.verify('attempts', '000000', 1), false);
  }
  assert.equal(cache.verify('attempts', code, 2), false);
});

test('reissuing replaces the pending challenge and refreshes its lifetime', () => {
  const cache = new MasterVerification();
  cache.issue('user', 0);
  const replacement = cache.issue('user', 200000);
  assert.equal(cache.verify('user', replacement, 300000), true);
});
