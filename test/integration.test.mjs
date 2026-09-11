import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { getDSHConfig } from '../lib/dsh/client.js';
import { ensureDSHSupervisor } from '../lib/dsh/supervisor.js';
import { SessionRegistry } from '../lib/state/registry.js';

const enabled = process.env.AGENT_LINK_INTEGRATION === '1';

test('real Redis transition recovery and sandbox preflight', { skip: !enabled }, async () => {
  const config = getDSHConfig();
  const registry = new SessionRegistry(config);
  const channelId = `integration-${randomUUID()}`;

  try {
    await registry.ready();
    const reset = await registry.beginReset(channelId);

    assert.equal(reset.transition, 'resetting');
    assert.ok(reset.operationId);
    assert.equal((await registry.beginReset(channelId)).operationId, reset.operationId);
    assert.equal(await registry.completeReset(channelId, reset.operationId), true);
    assert.equal((await registry.meta(channelId)).isolated, true);

    const purge = await registry.beginPurge(channelId);

    assert.equal(purge.transition, 'purging');
    assert.equal((await registry.beginPurge(channelId)).operationId, purge.operationId);
    await registry.purgeHash(await registry.groupKey(channelId));
    assert.equal((await registry.meta(channelId)).isolated, false);

    const supervisor = await ensureDSHSupervisor(config);

    await supervisor.start();
    assert.equal(supervisor.status().phase, 'ready');
  } finally {
    await registry.purgeHash(await registry.groupKey(channelId)).catch(() => undefined);
  }
});
