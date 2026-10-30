import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialPool } from '../lib/credentials/pool.js';
import { parseModelPool } from '../lib/model-pool/config.js';

const defaults = { provider: 'test', baseUrl: 'https://models.example/v1', model: 'fixture' };
const endpoint = (id, extra = {}) => ({ id, apiKey: 'fixture-model-key', capabilities: ['chat'], ...extra });

test('workspace selection and retries stay within marked endpoints and do not reuse normal sticky bindings', () => {
  const pool = new CredentialPool(
    parseModelPool(
      {
        strategy: 'sticky',
        endpoints: [endpoint('normal'), endpoint('work', { workspace: true }), endpoint('work-backup', { workspace: true, fallback: true })]
      },
      defaults
    )
  );
  try {
    const normal = pool.select({ stickyKey: 'conversation', exclude: new Set(['work', 'work-backup']), reserve: false });
    assert.equal(normal.endpointId, 'normal');
    const selected = pool.select({ stickyKey: 'conversation', workspaceOnly: true, reserve: false });
    assert.equal(selected.endpointId, 'work');
    const retry = selected.next();
    assert.equal(retry.endpointId, 'work-backup');
    assert.equal(retry.next(), null);
    assert.equal(pool.select({ workspaceOnly: true, exclude: new Set(['work', 'work-backup']), reserve: false }), null);
  } finally {
    pool.stop();
  }
});

test('an unrelated busy chat primary does not block a workspace fallback', () => {
  const pool = new CredentialPool(
    parseModelPool(
      { queueMaxWaitMs: 1000, endpoints: [endpoint('normal', { maxConcurrent: 1 }), endpoint('work-backup', { workspace: true, fallback: true })] },
      defaults
    )
  );
  try {
    const busy = pool.select({ stable: true, reserve: true });
    assert.equal(busy.endpointId, 'normal');
    const work = pool.select({ workspaceOnly: true, waitForCapacity: true, reserve: true });
    assert.equal(work.endpointId, 'work-backup');
    busy.report({ ok: true });
    work.report({ ok: true });
  } finally {
    pool.stop();
  }
});

test('a sticky binding does not bypass reserved or completed token windows', () => {
  const pool = new CredentialPool(parseModelPool({ strategy: 'sticky', endpoints: [endpoint('one', { tpm: 100, maxConcurrent: 3 })] }, defaults));
  try {
    const first = pool.select({ stickyKey: 'same', reserve: true, estimatedTokens: 80 });
    assert.ok(first);
    assert.equal(pool.select({ stickyKey: 'same', reserve: true, estimatedTokens: 80 }), null);
    first.reportUsage({ prompt_tokens: 70, completion_tokens: 10 });
    first.report({ ok: true });
    assert.equal(pool.select({ stickyKey: 'same', reserve: false, estimatedTokens: 30 }), null);
    assert.ok(pool.select({ stickyKey: 'same', reserve: false, estimatedTokens: 10 }));
    assert.ok(pool.status.every(row => row.active === 0));
  } finally {
    pool.stop();
  }
});
