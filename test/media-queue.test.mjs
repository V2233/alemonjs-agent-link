import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry } from '../lib/state/registry.js';
import { runCoordinatedChat, cancelChatForUser, conversationQueueScope } from '../lib/dsh/orchestrator.js';

const meta = { generation: 1, isolated: true, lastActivity: 0, policy: { version: 1, chat: true, web: false, files: false, terminal: false } };

test('media tasks deduplicate and rate limit before execution; cancellation aborts preparation before a model call', async () => {
  const methods = ['ready', 'meta', 'policy', 'deduplicate', 'allowUser', 'touch', 'releaseDeduplication', 'groupKey', 'finalizeDeduplication'];
  const originals = Object.fromEntries(methods.map(key => [key, SessionRegistry.prototype[key]]));
  const oldFetch = globalThis.fetch;
  const calls = [];
  let duplicate = false;
  Object.assign(SessionRegistry.prototype, {
    ready: async () => {},
    meta: async () => meta,
    policy: async () => meta.policy,
    deduplicate: async () => ({ duplicate, requestId: 'r' }),
    allowUser: async () => {
      calls.push('rate');
      return true;
    },
    touch: async () => meta,
    releaseDeduplication: async () => {
      calls.push('release');
    },
    groupKey: async () => 'hash',
    finalizeDeduplication: async () => true
  });
  globalThis.fetch = async () => assert.fail('media-only or cancelled preparation must not call the model');
  try {
    const event = { ChannelId: 'media-task', MessageId: 'm', UserKey: 'u' };
    const task = {
      execute: async () => {
        calls.push('send');
      }
    };
    await runCoordinatedChat(event, '', async () => {}, undefined, undefined, undefined, undefined, task);
    assert.deepEqual(calls, ['rate', 'send']);
    duplicate = true;
    assert.equal((await runCoordinatedChat(event, '', async () => {}, undefined, undefined, undefined, undefined, task)).duplicate, true);
    assert.deepEqual(calls, ['rate', 'send']);
    duplicate = false;
    let started;
    const start = new Promise(resolve => {
      started = resolve;
    });
    const pending = runCoordinatedChat({ ...event, ChannelId: 'media-cancel' }, '', async () => {}, undefined, undefined, undefined, undefined, {
      prepareMessage: async (_text, signal) => {
        started();
        return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    });
    const rejection = assert.rejects(pending, error => error.kind === 'cancelled');
    await start;
    assert.equal(cancelChatForUser('media-cancel', 'u', false, conversationQueueScope(getDSHConfig(), {})), 'cancelled-running');
    await rejection;
    assert.equal(calls.at(-1), 'release');
  } finally {
    Object.assign(SessionRegistry.prototype, originals);
    globalThis.fetch = oldFetch;
  }
});
