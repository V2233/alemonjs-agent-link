import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionRegistry } from '../lib/state/registry.js';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { conversationQueueScope } from '../lib/dsh/conversation-scope.js';
import { runCoordinatedChat } from '../lib/dsh/orchestrator.js';
import { runDSHChat } from '../lib/response/dsh/chat.js';
import { respondToGroupBatch } from '../lib/social/respond.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { messageReferences } from '../lib/social/references.js';
import { ResultCode } from 'alemonjs';

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'dedupe-scope-'));
  const previous = globalThis.__config;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        stateBackend: 'local',
        runtimeMode: 'chat-only',
        budget: { enabled: false }
      }
    }
  };
  const config = getDSHConfig(),
    registry = new SessionRegistry(config);
  const identity = (platform = 'onebot', botId = 'a', value = config) => conversationQueueScope(value, { platform, botId });
  try {
    await run({ root, config, registry, identity });
  } finally {
    globalThis.__config = previous;
    await rm(root, { recursive: true, force: true });
  }
};

test('same ID is accepted independently for platform/bot/installations, but once per exact scope under concurrent claims', () =>
  fixture(async f => {
    const scopes = [
      f.identity(),
      f.identity('other'),
      f.identity('onebot', 'b'),
      f.identity('onebot', 'a', { ...f.config, workspaceRoot: join(f.root, 'other-work') }),
      f.identity('onebot', ''),
      f.identity('', '')
    ];
    for (const scope of scopes) {
      const claims = await Promise.all(Array.from({ length: 12 }, () => f.registry.deduplicate('same-group', 'same-message', scope)));
      assert.equal(claims.filter(item => !item.duplicate).length, 1);
    }
    const snapshot = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8'));
    const keys = Object.keys(snapshot.entries).filter(key => key.includes(':dedupe.v2:'));
    assert.equal(keys.length, scopes.length);
    assert.ok(
      keys.every(key => !key.includes('same-message') && !key.includes(f.root)),
      'IDs and directory identity must not appear raw in the persisted key'
    );
  }));

test('confirmation and release require both the original identity and current claim owner', () =>
  fixture(async f => {
    const a = await f.registry.deduplicate('g', 'm', f.identity()),
      b = await f.registry.deduplicate('g', 'm', f.identity('onebot', 'b'));
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, false);
    assert.equal(await f.registry.finalizeDeduplication('g', 'm', a.requestId, f.identity('onebot', 'b')), false);
    await f.registry.releaseDeduplication('g', 'm', a.requestId, f.identity('onebot', 'b'));
    assert.equal((await f.registry.deduplicate('g', 'm', f.identity('onebot', 'b'))).duplicate, true);
    await f.registry.releaseDeduplication('g', 'm', a.requestId, f.identity());
    const next = await f.registry.deduplicate('g', 'm', f.identity());
    assert.equal(next.duplicate, false);
    assert.equal(await f.registry.finalizeDeduplication('g', 'm', a.requestId, f.identity()), false);
    await f.registry.releaseDeduplication('g', 'm', a.requestId, f.identity());
    assert.equal((await f.registry.deduplicate('g', 'm', f.identity())).duplicate, true, 'late release cannot remove the new owner');
    assert.equal(await f.registry.finalizeDeduplication('g', 'm', next.requestId, f.identity()), true);
    await f.registry.releaseDeduplication('g', 'm', next.requestId, f.identity());
    assert.equal((await f.registry.deduplicate('g', 'm', f.identity())).duplicate, true, 'delivered claims are not released by a delayed failure callback');
  }));

test('legacy claims remain untouched and unassigned instead of silently suppressing another scoped identity', () =>
  fixture(async f => {
    const legacy = await f.registry.deduplicate('g', 'm');
    assert.equal(await f.registry.finalizeDeduplication('g', 'm', legacy.requestId), true);
    const scoped = await f.registry.deduplicate('g', 'm', f.identity());
    assert.equal(scoped.duplicate, false);
    assert.equal(await f.registry.finalizeDeduplication('g', 'm', legacy.requestId, f.identity()), false);
    await f.registry.releaseDeduplication('g', 'm', scoped.requestId);
    assert.equal((await f.registry.deduplicate('g', 'm', f.identity())).duplicate, true);
    assert.equal((await f.registry.deduplicate('g', 'm')).duplicate, true);
  }));

test('group-hash purge clears new scoped claims across identities while preserving another group', () =>
  fixture(async f => {
    await f.registry.deduplicate('remove', 'm', f.identity());
    await f.registry.deduplicate('remove', 'm', f.identity('other'));
    await f.registry.deduplicate('keep', 'm', f.identity());
    await f.registry.purgeHash(await f.registry.groupKey('remove'), false);
    assert.equal((await f.registry.deduplicate('remove', 'm', f.identity())).duplicate, false);
    assert.equal((await f.registry.deduplicate('remove', 'm', f.identity('other'))).duplicate, false);
    assert.equal((await f.registry.deduplicate('keep', 'm', f.identity())).duplicate, true);
  }));

test('scoped delivered claim survives a real process restart with an independent bot still eligible', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dedupe-restart-'));
  const imports = {
    config: new URL('../lib/dsh/runtime-config.js', import.meta.url).href,
    registry: new URL('../lib/state/registry.js', import.meta.url).href,
    scope: new URL('../lib/dsh/conversation-scope.js', import.meta.url).href
  };
  const script = `import{getDSHConfig}from${JSON.stringify(imports.config)};import{SessionRegistry}from${JSON.stringify(imports.registry)};import{conversationQueueScope}from${JSON.stringify(imports.scope)};const[root,bot,confirm]=process.argv.slice(1);const config=getDSHConfig({workspaceRoot:root+'/work',dshHomeRoot:root+'/home',stateBackend:'local'}),registry=new SessionRegistry(config),scope=conversationQueueScope(config,{platform:'onebot',botId:bot});const claim=await registry.deduplicate('g','m',scope);if(confirm==='yes')await registry.finalizeDeduplication('g','m',claim.requestId,scope);console.log('RESULT:'+JSON.stringify({duplicate:claim.duplicate}));process.exit(0);`;
  const child = async (bot, confirm = 'no') => {
    const output = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, root, bot, confirm], { timeout: 10000 });
    return JSON.parse(
      output.stdout
        .split('\n')
        .find(line => line.startsWith('RESULT:'))
        .slice(7)
    );
  };
  try {
    assert.equal((await child('a', 'yes')).duplicate, false);
    assert.equal((await child('a')).duplicate, true);
    assert.equal((await child('b')).duplicate, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real coordinated entry claims and confirms per bot using the actual local registry, without model or platform calls', { timeout: 10000 }, () =>
  fixture(async f => {
    const event = { ChannelId: 'coordinated-dedupe', Platform: 'onebot', BotId: 'a', UserId: 'u', UserKey: 'u', MessageId: 'same' };
    let executions = 0;
    const execute = {
      execute: async () => {
        executions++;
      }
    };
    const first = await runCoordinatedChat(event, '', async () => {}, undefined, undefined, undefined, undefined, execute);
    assert.equal(first.duplicate, false);
    await first.confirmDelivery();
    const replay = await runCoordinatedChat(event, '', async () => {}, undefined, undefined, undefined, undefined, execute);
    assert.equal(replay.duplicate, true);
    const other = await runCoordinatedChat({ ...event, BotId: 'b' }, '', async () => {}, undefined, undefined, undefined, undefined, execute);
    assert.equal(other.duplicate, false);
    await other.confirmDelivery();
    assert.equal(executions, 2);
    assert.equal((await f.registry.deduplicate(event.ChannelId, event.MessageId, f.identity('onebot', 'b'))).duplicate, true);
    const before = await f.registry.deduplicate('released-entry', 'failed', f.identity());
    assert.equal(before.duplicate, false);
    await f.registry.releaseDeduplication('released-entry', 'failed', before.requestId, f.identity());
    const retry = await runCoordinatedChat(
      { ...event, ChannelId: 'released-entry', MessageId: 'failed' },
      '',
      async () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      execute
    );
    await retry.release();
    assert.equal((await f.registry.deduplicate('released-entry', 'failed', f.identity())).duplicate, false);
  })
);

test('actual group batch intake confirms each bot source claim independently and suppresses only its own replay', { timeout: 10000 }, () =>
  fixture(async f => {
    const raw = globalThis.__config.value['alemonjs-agent-link'];
    raw.apiKey = 'synthetic';
    raw.model = 'synthetic';
    raw.modules = { disabled: ['opinions'], settings: { memory: { automatic: false }, mood: { modelJudge: false }, expression: { automatic: false } } };
    const config = getDSHConfig(),
      previousFetch = globalThis.fetch;
    let requests = 0,
      sends = 0;
    globalThis.fetch = async url => {
      assert.ok(String(url).endsWith('/chat/completions'));
      requests++;
      return Response.json({ choices: [{ message: { content: '收到。' } }] });
    };
    const transport = {
      message: {
        send: async () => {
          sends++;
          return [{ code: ResultCode.Ok, data: { id: `synthetic-${sends}` } }];
        }
      },
      media: { send: async () => assert.fail('no media') }
    };
    const run = async botId => {
      const event = { Platform: 'onebot', BotId: botId, ChannelId: 'batch-scope', UserId: 'u', UserKey: 'u', MessageId: 'same' };
      const anchor = {
        platform: event.Platform,
        botId,
        channelId: event.ChannelId,
        id: event.MessageId,
        userId: 'u',
        userKey: 'u',
        name: 'u',
        owner: false,
        text: '聊猫',
        direct: true,
        explicitMention: true
      };
      return respondToGroupBatch(event, transport, { id: 'same-batch', mode: 'direct', anchor, messages: [anchor] });
    };
    try {
      assert.equal((await run('a')).delivered, true);
      assert.equal((await run('a')).delivered, false);
      assert.equal((await run('b')).delivered, true);
      assert.equal(requests, 2);
      assert.equal(sends, 2);
      const registry = new SessionRegistry(config);
      assert.equal((await registry.deduplicate('batch-scope', 'group-message:same', f.identity())).duplicate, true);
      assert.equal((await registry.deduplicate('batch-scope', 'group-message:same', f.identity('onebot', 'b'))).duplicate, true);
    } finally {
      globalThis.fetch = previousFetch;
      await messageReferences.clear('batch-scope');
      await (await getModuleRuntime(config)).close();
    }
  })
);

test('actual unsupported-media fallback scopes confirmation and failed-send release without a model request', { timeout: 10000 }, () =>
  fixture(async f => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => assert.fail('unsupported input must not call a model or download media');
    let sends = 0,
      shouldFail = false;
    const transport = {
      message: {
        send: async () => {
          sends++;
          if (shouldFail) throw new Error('synthetic failed send');
          return [{ code: ResultCode.Ok }];
        }
      },
      media: { send: async () => assert.fail('no media sends') }
    };
    const run = async botId => {
      let outcome;
      await runDSHChat(
        {
          Platform: 'onebot',
          BotId: botId,
          ChannelId: 'media-scope',
          UserId: 'u',
          UserKey: 'u',
          MessageId: 'same',
          MessageMedia: [{ Type: 'video', Url: 'https://invalid.example/synthetic.mp4' }]
        },
        '附件',
        {
          referencesPrepared: true,
          transport,
          onOutcome: result => {
            outcome = result;
          }
        }
      );
      return outcome;
    };
    try {
      assert.equal((await run('a')).delivered, true);
      assert.equal((await run('a')).delivered, false);
      assert.equal((await run('b')).delivered, true);
      assert.equal(sends, 2);
      shouldFail = true;
      await assert.rejects(run('c'), /synthetic failed send/);
      shouldFail = false;
      assert.equal((await run('c')).delivered, true);
      assert.equal((await f.registry.deduplicate('media-scope', 'same', f.identity('onebot', 'c'))).duplicate, true);
    } finally {
      globalThis.fetch = oldFetch;
    }
  })
);
