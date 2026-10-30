import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { conversationQueueKey, conversationQueueScope } from '../lib/dsh/conversation-scope.js';
import { enqueueChat, conversationBusy, cancelChatForUser, cancelGroupChat, runCoordinatedChat } from '../lib/dsh/orchestrator.js';
import { SessionRegistry } from '../lib/state/registry.js';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { MessageReferences } from '../lib/social/references.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};
const scope = (platform = 'onebot', botId = 'bot-a', namespace = 'installation-a') => ({ platform, botId, namespace });
const blocked = (channel, identity) => {
  const began = deferred(),
    release = deferred();
  let signal;
  const promise = enqueueChat(
    channel,
    0,
    'same-user',
    async current => {
      signal = current;
      began.resolve();
      await release.promise;
      current.throwIfAborted();
    },
    undefined,
    undefined,
    identity
  );
  return { began: began.promise, promise, release: release.resolve, signal: () => signal };
};

test('queue identity uses tuples and separates platform, bot, installation and missing identities', () => {
  const variants = [scope(), scope('other'), scope('onebot', 'bot-b'), scope('onebot', 'bot-a', 'other-installation'), scope('onebot', ''), scope('', '')];
  assert.equal(new Set(variants.map(item => conversationQueueKey('same-group', item))).size, variants.length);
  assert.notEqual(conversationQueueKey('x:y', scope('a', 'b')), conversationQueueKey('y', scope('a', 'b:x')));
  assert.notEqual(conversationQueueKey('same-group'), conversationQueueKey('same-group', scope()));
});

test('same scope keeps FIFO and queue limit while other platform/bot/installations can proceed', { timeout: 10000 }, async () => {
  const first = blocked('scope-fifo', scope());
  await first.began;
  try {
    await assert.rejects(
      enqueueChat('scope-fifo', 0, 'other', async () => {}, undefined, undefined, scope()),
      /排队已满/
    );
    const started = [];
    for (const identity of [scope('other'), scope('onebot', 'bot-b'), scope('onebot', 'bot-a', 'other-installation')]) {
      await enqueueChat(
        'scope-fifo',
        0,
        'other',
        async () => {
          started.push(identity);
        },
        undefined,
        undefined,
        identity
      );
    }
    assert.equal(started.length, 3);
    assert.equal(conversationBusy('scope-fifo', scope()), true);
    assert.equal(conversationBusy('scope-fifo', scope('other')), false);
    assert.equal(conversationBusy('scope-fifo'), true, 'legacy broad busy query remains conservative');
  } finally {
    first.release();
    await first.promise;
  }
});

test('ordinary and privileged cancellation cannot cancel another scoped queue with the same channel/user', { timeout: 10000 }, async () => {
  const a = blocked('scope-cancel', scope()),
    b = blocked('scope-cancel', scope('onebot', 'bot-b'));
  const rejection = assert.rejects(a.promise, error => error.name === 'AbortError');
  await Promise.all([a.began, b.began]);
  try {
    assert.equal(cancelChatForUser('scope-cancel', 'same-user', true, scope('other')), 'empty');
    assert.equal(cancelChatForUser('scope-cancel', 'same-user', false, scope()), 'cancelled-running');
    assert.equal(a.signal().aborted, true);
    assert.equal(b.signal().aborted, false);
    assert.equal(conversationBusy('scope-cancel', scope('onebot', 'bot-b')), true);
  } finally {
    a.release();
    b.release();
    await Promise.all([rejection, b.promise]);
  }
});

test('scoped withdrawal cancels only matching active and queued work; omitted-scope reset retains its broad boundary', { timeout: 10000 }, async () => {
  const a = blocked('scope-reset', scope()),
    b = blocked('scope-reset', scope('other'));
  const activeFailure = assert.rejects(a.promise, /abort/i);
  await Promise.all([a.began, b.began]);
  const pending = enqueueChat('scope-reset', 2, 'queued', async () => assert.fail('cancelled job ran'), undefined, undefined, scope());
  const queuedFailure = assert.rejects(pending, error => error.kind === 'cancelled');
  try {
    cancelGroupChat('scope-reset', false, scope());
    assert.equal(a.signal().aborted, true);
    assert.equal(b.signal().aborted, false);
    await queuedFailure;
  } finally {
    a.release();
    b.release();
    await Promise.all([activeFailure, b.promise]);
  }
  const c = blocked('scope-reset-broad', scope()),
    d = blocked('scope-reset-broad', scope('other'));
  const failures = [assert.rejects(c.promise, /abort/i), assert.rejects(d.promise, /abort/i)];
  await Promise.all([c.began, d.began]);
  cancelGroupChat('scope-reset-broad', false);
  assert.equal(c.signal().aborted, true);
  assert.equal(d.signal().aborted, true);
  c.release();
  d.release();
  await Promise.all(failures);
});

test('actual coordinated execution routes platform/bot identities to busy and cancellation helpers without changing platform channel', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'queue-routing-'));
  const previous = globalThis.__config;
  const originals = Object.fromEntries(
    ['ready', 'meta', 'policy', 'deduplicate', 'allowUser', 'touch', 'releaseDeduplication', 'groupKey', 'finalizeDeduplication'].map(name => [
      name,
      SessionRegistry.prototype[name]
    ])
  );
  const policy = { version: 2, chat: true, web: true, files: true, terminal: false };
  const meta = { generation: 1, isolated: true, policy };
  globalThis.__config = {
    value: { 'alemonjs-agent-link': { workspaceRoot: join(root, 'work'), dshHomeRoot: join(root, 'home'), runtimeMode: 'chat-only', stateBackend: 'local' } }
  };
  const channels = [];
  Object.assign(SessionRegistry.prototype, {
    ready: async () => {},
    meta: async channel => {
      channels.push(channel);
      return meta;
    },
    policy: async () => policy,
    deduplicate: async () => ({ duplicate: false, requestId: 'synthetic-request' }),
    allowUser: async () => true,
    touch: async () => meta,
    releaseDeduplication: async () => true,
    groupKey: async () => 'synthetic-hash',
    finalizeDeduplication: async () => true
  });
  const beganA = deferred(),
    beganB = deferred(),
    release = deferred();
  const event = { ChannelId: 'raw-platform-group', Platform: 'onebot', BotId: 'bot-a', MessageId: 'synthetic', UserKey: 'same-user', UserId: 'u' };
  const config = getDSHConfig(),
    identityA = conversationQueueScope(config, { platform: event.Platform, botId: event.BotId }),
    identityB = conversationQueueScope(config, { platform: event.Platform, botId: 'bot-b' });
  let signalA, signalB;
  let first, second;
  try {
    first = runCoordinatedChat(event, '', async () => {}, undefined, undefined, undefined, undefined, {
      execute: async signal => {
        signalA = signal;
        beganA.resolve();
        await release.promise;
        signal.throwIfAborted();
      }
    });
    const rejection = assert.rejects(first, error => error.kind === 'cancelled');
    await beganA.promise;
    second = runCoordinatedChat({ ...event, BotId: 'bot-b' }, '', async () => {}, undefined, undefined, undefined, undefined, {
      execute: async signal => {
        signalB = signal;
        beganB.resolve();
        await release.promise;
        signal.throwIfAborted();
      }
    });
    await beganB.promise;
    assert.equal(conversationBusy(event.ChannelId, identityA), true);
    assert.equal(conversationBusy(event.ChannelId, identityB), true);
    assert.equal(cancelChatForUser(event.ChannelId, 'same-user', true, identityA), 'cancelled-running');
    assert.equal(signalA.aborted, true);
    assert.equal(signalB.aborted, false);
    assert.ok(
      channels.every(channel => channel === event.ChannelId),
      'platform channel must remain raw for existing registry/tool routing'
    );
    release.resolve();
    await Promise.all([rejection, second]);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    Object.assign(SessionRegistry.prototype, originals);
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('scoped reference clearing preserves another platform/bot with the same raw group', { timeout: 10000 }, async () => {
  const references = new MessageReferences();
  const event = { Platform: 'onebot', BotId: 'a', ChannelId: 'same-group', UserId: 'u', MessageId: 'm', MessageText: '猫' };
  await references.capture(event);
  await references.capture({ ...event, BotId: 'b' });
  await references.clear('same-group', { platform: 'onebot', botId: 'a' });
  const a = await references.capture({ ...event, MessageId: 'reply-a', ReplyId: 'm', MessageText: '接话' });
  const b = await references.capture({ ...event, BotId: 'b', MessageId: 'reply-b', ReplyId: 'm', MessageText: '接话' });
  assert.equal(a.quote, undefined);
  assert.equal(b.quote?.text, '猫');
});
