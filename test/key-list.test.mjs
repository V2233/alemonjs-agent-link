import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { listUserKeys } from '../lib/panel/key-list.js';
import router from '../lib/api-router.js';
const owner = { platform: 'qq-bot', userId: 'alice' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = hash([owner.platform, owner.userId]);
const oldId = hash(['qq-bot', 'old-user']);
const personal = `data:{agent-link-personal-keys}:v1:${id}`;
const ring = `data:{agent-link-group-keys}:v1:ring:${id}`;
const value = { encrypted: 'private-ciphertext-must-not-return', revision: 'secret-revision', enabled: false, reason: 'balance' };
const records = new Map([
  [personal, JSON.stringify(value)],
  [personal + ':command:abc', '1'],
  [
    ring,
    JSON.stringify({
      owner,
      keys: [
        { id: 1, value },
        { id: 2, value: { ...value, enabled: true, auth: 'account' } }
      ],
      grants: [{ keyId: 1, token: 'secret-grant', channelId: 'group' }]
    })
  ],
  [`data:{agent-link-personal-keys}:v1:${oldId}`, JSON.stringify({ ...value, owner })]
]);
const redis = {
  status: 'ready',
  async ping() {
    return 'PONG';
  },
  options: { keyPrefix: 'test:' },
  async scan(cursor, _, pattern) {
    const keys = [...records.keys()].filter(key => ('test:' + key).startsWith(pattern.slice(0, -1))).map(key => 'test:' + key);
    return ['0', [...keys, ...keys]]; // SCAN may return duplicates.
  },
  async get(key) {
    return records.get(key) || null;
  }
};
test('user list includes personal and owned group keys, masks secrets and preserves unknown historical owners', async () => {
  const result = await listUserKeys(redis);
  assert.equal(result.total, 4);
  const alice = result.keys.filter(row => row.ownerId === id);
  assert.equal(alice.length, 3);
  assert.ok(alice.every(row => row.userId === 'alice' && row.platform === 'qq-bot'));
  assert.equal(alice.find(row => row.number === 1).grantRecords, 1);
  assert.equal(result.keys.find(row => row.ownerId === oldId).userId, null);
  assert.ok(result.keys.every(row => row.apiKey === '***'));
  for (const secret of ['private-ciphertext', 'secret-revision', 'secret-grant', 'encrypted']) assert.ok(!JSON.stringify(result).includes(secret));
});
test('GET /api/admin/keys returns user-owned keys instead of configured robot keys', async () => {
  const previous = { config: globalThis.__config, redis: globalThis.ioRedis };
  globalThis.__config = { value: { db: { redis: {} }, 'alemonjs-agent-link': { apiKey: 'robot-secret', modelPool: { endpoints: [] } } } };
  globalThis.ioRedis = redis;
  try {
    const route = router.stack.find(layer => layer.path === '/api/admin/keys' && layer.methods.includes('GET'));
    const ctx = {};
    await route.stack.at(-1)(ctx);
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body.data.total, 4);
    assert.ok(!JSON.stringify(ctx.body).includes('robot-secret'));
    globalThis.__config.value.db = {};
    await route.stack.at(-1)(ctx);
    assert.deepEqual(ctx.body.data, { total: 0, keys: [] });
  } finally {
    globalThis.__config = previous.config;
    globalThis.ioRedis = previous.redis;
  }
});
