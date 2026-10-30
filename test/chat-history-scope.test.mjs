import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ResultCode } from 'alemonjs';
import { SessionRegistry } from '../lib/state/registry.js';
import { getLocalStore } from '../lib/state/local-store.js';
import { getDSHConfig } from '../lib/dsh/runtime-config.js';
import { conversationQueueScope } from '../lib/dsh/conversation-scope.js';
import { runDSHChat } from '../lib/response/dsh/chat.js';
import { resetGroupSession } from '../lib/dsh/orchestrator.js';
import { directChat } from '../lib/dsh/direct-chat.js';
import { getModuleRuntime } from '../lib/agent/modules.js';
import { messageReferences } from '../lib/social/references.js';
import { recordRecentMessage, getRecentMessages, clearRecentMessages } from '../lib/chat-context/store.js';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};
const fixture = async (run, options = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'history-scope-')),
    oldConfig = globalThis.__config;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'synthetic',
        model: 'synthetic',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        budget: { enabled: false },
        privateHistoryMaxTurns: 4,
        privateHistoryMaxChars: 5000,
        modules: { disabled: ['opinions'], settings: { memory: { automatic: false }, mood: { modelJudge: false }, expression: { automatic: false } } },
        ...options
      }
    }
  };
  const config = getDSHConfig(),
    registry = new SessionRegistry(config),
    generations = new Map();
  const init = async channelId => {
    if (!generations.has(channelId)) {
      const state = await registry.beginReset(channelId);
      await registry.completeReset(channelId, state.operationId);
      generations.set(channelId, state.generation);
    }
    return generations.get(channelId);
  };
  const context = async (botId = 'a', channelId = 'g', platform = 'onebot', value = config) => ({
    channelId,
    generation: await init(channelId),
    scope: conversationQueueScope(value, { platform, botId })
  });
  try {
    await run({ root, config, registry, context, init });
  } finally {
    globalThis.__config = oldConfig;
    await rm(root, { recursive: true, force: true });
  }
};
const append = async (registry, context, user, reply) => {
  await registry.appendPrivateTurn(context, user, reply);
  await new Promise(resolve => setTimeout(resolve, 2));
};

test('transcripts separate bots, platforms, installations and unknown identities without importing legacy rows', () =>
  fixture(async f => {
    const a = await f.context();
    await f.registry.appendPrivateTurn({ channelId: a.channelId, generation: a.generation }, '__LEGACY_ONLY__', 'legacy');
    await f.registry.appendPrivateTurn(a, '__A_ONLY__', 'a');
    assert.match(JSON.stringify(await f.registry.privateHistory(a)), /__A_ONLY__/);
    assert.doesNotMatch(JSON.stringify(await f.registry.privateHistory(a)), /__LEGACY_ONLY__/);
    for (const context of [
      await f.context('b'),
      await f.context('a', 'g', 'other'),
      await f.context('', 'g', ''),
      await f.context('a', 'g', 'onebot', { ...f.config, workspaceRoot: join(f.root, 'other-work') })
    ])
      assert.deepEqual(await f.registry.privateHistory(context), []);
    assert.match(JSON.stringify(await f.registry.privateHistory({ channelId: a.channelId, generation: a.generation })), /__LEGACY_ONLY__/);
  }));

test('compaction and autonomous turns retain roles within their own identity, never another bot digest', () =>
  fixture(
    async f => {
      const a = await f.context(),
        b = await f.context('b');
      for (let i = 0; i < 3; i++) await append(f.registry, a, `__A_USER_${i}__`, `__A_REPLY_${i}__`);
      const compacted = await f.registry.privateHistory(a);
      assert.equal(compacted[0].role, 'system');
      assert.match(compacted[0].content, /__A_USER_0__/);
      assert.deepEqual(await f.registry.privateHistory(b), []);
      await f.registry.appendPrivateTurn(b, 'system wake prompt must not become user', '__B_AUTONOMOUS__', true);
      assert.deepEqual(await f.registry.privateHistory(b), [{ role: 'assistant', content: '__B_AUTONOMOUS__' }]);
      assert.doesNotMatch(JSON.stringify(await f.registry.privateHistory(a)), /__B_AUTONOMOUS__/);
    },
    { privateHistoryMaxTurns: 1 }
  ));

test('late pre-reset compaction cannot overwrite a new-generation anchor, and stale turns cannot append', { timeout: 10000 }, () =>
  fixture(
    async f => {
      const old = await f.context();
      for (let i = 0; i < 3; i++) await append(f.registry, old, `__OLD_${i}__`, 'old');
      const store = await getLocalStore(join(f.root, 'state.json')),
        originalEval = store.eval;
      const entered = deferred(),
        release = deferred();
      let held = false,
        reading;
      store.eval = async function (script, ...args) {
        if (script.startsWith('-- agent-link:writeHistoryAnchor') && !held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return originalEval.call(this, script, ...args);
      };
      try {
        reading = f.registry.privateHistory(old);
        await entered.promise;
        const reset = await f.registry.beginReset(old.channelId);
        await f.registry.clearPrivateHistory(old.channelId);
        await f.registry.completeReset(old.channelId, reset.operationId);
        const current = { ...old, generation: reset.generation };
        for (let i = 0; i < 3; i++) await append(f.registry, current, `__NEW_${i}__`, 'new');
        assert.match(JSON.stringify(await f.registry.privateHistory(current)), /__NEW_0__/);
        release.resolve();
        await reading;
        await f.registry.appendPrivateTurn(old, '__STALE_APPEND__', 'must not return');
        const result = JSON.stringify(await f.registry.privateHistory(current));
        assert.match(result, /__NEW_0__/);
        assert.doesNotMatch(result, /__OLD_|__STALE_APPEND__/);
      } finally {
        release.resolve();
        await reading;
        store.eval = originalEval;
      }
    },
    { privateHistoryMaxTurns: 1 }
  )
);

test('history clearing can target one identity while raw-generation reset and purge cover all variants', () =>
  fixture(async f => {
    const a = await f.context(),
      b = await f.context('b'),
      otherGroup = await f.context('a', 'other-group');
    for (const context of [a, b, otherGroup]) await f.registry.appendPrivateTurn(context, 'question', 'reply');
    await f.registry.clearPrivateHistory('g', a.scope);
    assert.deepEqual(await f.registry.privateHistory(a), []);
    assert.equal((await f.registry.privateHistory(b)).length, 2);
    await f.registry.clearPrivateHistory('g');
    assert.deepEqual(await f.registry.privateHistory(b), []);
    assert.equal((await f.registry.privateHistory(otherGroup)).length, 2);
    await f.registry.appendPrivateTurn(b, 'recreated', 'reply');
    await f.registry.purge('g');
    const snapshot = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8'));
    const hash = await f.registry.groupKey('g');
    assert.equal(
      Object.keys(snapshot.entries).some(key => key.startsWith(`data:agent-link:group:${hash}:`)),
      false
    );
    assert.equal((await f.registry.privateHistory(otherGroup)).length, 2);
  }));

test('recent context wrappers isolate identity and exclusion; scoped clearing preserves other bots and unscoped reset clears variants', () =>
  fixture(async f => {
    const a = await f.context(),
      b = await f.context('b'),
      options = { maxMessages: 10, maxChars: 1000, windowSeconds: 900 };
    await recordRecentMessage('g', { id: 'same', text: '__A_RECENT__' }, options, f.config, a.scope);
    await recordRecentMessage('g', { id: 'same', text: '__B_RECENT__' }, options, f.config, b.scope);
    assert.match(JSON.stringify(await getRecentMessages('g', options, f.config, undefined, a.scope)), /__A_RECENT__/);
    assert.doesNotMatch(JSON.stringify(await getRecentMessages('g', options, f.config, undefined, b.scope)), /__A_RECENT__/);
    assert.deepEqual(await getRecentMessages('g', options, f.config, 'same', a.scope), []);
    await recordRecentMessage('g', { text: '__IDLESS_RECENT__' }, options, f.config, a.scope);
    assert.match(JSON.stringify(await getRecentMessages('g', options, f.config, undefined, a.scope)), /__IDLESS_RECENT__/);
    await clearRecentMessages('g', f.config, a.scope);
    assert.deepEqual(await f.registry.recent('g', undefined, a.scope), []);
    assert.equal((await f.registry.recent('g', undefined, b.scope)).length, 1);
    await f.registry.clearRecent('g');
    assert.deepEqual(await f.registry.recent('g', undefined, b.scope), []);
  }));

test('actual chat/model request reads and appends its own transcript and recent context without importing another bot or legacy text', { timeout: 10000 }, () =>
  fixture(async f => {
    const a = await f.context(),
      b = await f.context('b');
    await f.registry.recordRecent('g', { text: '__LEGACY_RECENT__' });
    await f.registry.recordRecent('g', { text: '__A_RECENT__' }, a.scope);
    await f.registry.recordRecent('g', { text: '__B_RECENT__' }, b.scope);
    const oldFetch = globalThis.fetch,
      requests = [];
    let sends = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body.messages);
      return Response.json({ choices: [{ message: { content: requests.length === 2 ? '__B_REPLY__' : '__A_REPLY__' } }] });
    };
    const transport = {
      message: { send: async () => [{ code: ResultCode.Ok, data: { id: `synthetic-${++sends}` } }] },
      media: { send: async () => assert.fail('no media') }
    };
    const run = async (botId, id, prompt) =>
      runDSHChat({ Platform: 'onebot', BotId: botId, ChannelId: 'g', UserId: 'u', UserKey: 'u', MessageId: id }, prompt, {
        referencesPrepared: true,
        transport,
        userText: prompt
      });
    try {
      await run('a', 'a1', '__A_QUESTION__');
      await run('b', 'b1', '__B_QUESTION__');
      await run('a', 'a2', '__A_NEXT__');
      assert.equal(requests.length, 3);
      assert.equal(sends, 3);
      assert.match(JSON.stringify(requests[0]), /__A_RECENT__/);
      assert.doesNotMatch(JSON.stringify(requests[0]), /__B_|__LEGACY_/);
      assert.match(JSON.stringify(requests[1]), /__B_RECENT__/);
      assert.doesNotMatch(JSON.stringify(requests[1]), /__A_|__LEGACY_/);
      assert.match(JSON.stringify(requests[2]), /__A_QUESTION__/);
      assert.match(JSON.stringify(requests[2]), /__A_REPLY__/);
      assert.doesNotMatch(JSON.stringify(requests[2]), /__B_|__LEGACY_/);
      assert.match(JSON.stringify(await f.registry.privateHistory(a)), /__A_NEXT__/);
      assert.doesNotMatch(JSON.stringify(await f.registry.privateHistory(b)), /__A_/);
      await resetGroupSession('g', f.config);
      const reset = await f.registry.meta('g');
      assert.deepEqual(await f.registry.privateHistory({ ...a, generation: reset.generation }), []);
      assert.deepEqual(await f.registry.privateHistory({ ...b, generation: reset.generation }), []);
      await f.registry.appendPrivateTurn(a, '__LATE_PRE_RESET__', 'must not be stored');
      await run('a', 'a-after-reset', '__RESET_QUESTION__');
      assert.equal(requests.length, 4);
      assert.equal(sends, 4);
      assert.doesNotMatch(JSON.stringify(requests[3]), /__A_QUESTION__|__A_RECENT__|__B_|__LEGACY_|__LATE_PRE_RESET__/);
    } finally {
      globalThis.fetch = oldFetch;
      await messageReferences.clear('g');
      await (await getModuleRuntime(f.config)).close();
    }
  })
);

test('scoped transcript and recent records survive process restart without becoming another bot history', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-restart-'));
  const modules = {
    registry: new URL('../lib/state/registry.js', import.meta.url).href,
    config: new URL('../lib/dsh/runtime-config.js', import.meta.url).href,
    scope: new URL('../lib/dsh/conversation-scope.js', import.meta.url).href
  };
  const code = `import{SessionRegistry}from${JSON.stringify(modules.registry)};import{getDSHConfig}from${JSON.stringify(modules.config)};import{conversationQueueScope}from${JSON.stringify(modules.scope)};const[root,bot,write]=process.argv.slice(1);const config=getDSHConfig({workspaceRoot:root+'/work',dshHomeRoot:root+'/home',stateBackend:'local'}),registry=new SessionRegistry(config);let meta=await registry.meta('g');if(!meta.isolated){meta=await registry.beginReset('g');await registry.completeReset('g',meta.operationId);}const ctx={channelId:'g',generation:meta.generation,scope:conversationQueueScope(config,{platform:'onebot',botId:bot})};if(write==='yes'){await registry.appendPrivateTurn(ctx,'__A_ONLY__','reply');await registry.recordRecent('g',{text:'__A_RECENT__'},ctx.scope);}console.log('RESULT:'+JSON.stringify({history:await registry.privateHistory(ctx),recent:await registry.recent('g',undefined,ctx.scope)}));process.exit(0);`;
  const child = async (bot, write = 'no') => {
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, root, bot, write], { timeout: 10000 });
    return JSON.parse(
      result.stdout
        .split('\n')
        .find(line => line.startsWith('RESULT:'))
        .slice(7)
    );
  };
  try {
    await child('a', 'yes');
    const own = await child('a'),
      other = await child('b');
    assert.equal(own.history.length, 2);
    assert.equal(own.recent.length, 1);
    assert.deepEqual(other, { history: [], recent: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('purging metadata rejects a late digest write even when its generation has not changed', () =>
  fixture(
    async f => {
      const context = await f.context();
      for (let i = 0; i < 3; i++) await append(f.registry, context, `__PURGE_${i}__`, 'reply');
      const purging = await f.registry.beginPurge('g');
      assert.equal(purging.generation, context.generation);
      await f.registry.privateHistory(context);
      const snapshot = JSON.parse(await readFile(join(f.root, 'state.json'), 'utf8'));
      assert.equal(
        Object.keys(snapshot.entries).some(key => key.includes(':private-anchor.v2:')),
        false
      );
    },
    { privateHistoryMaxTurns: 1 }
  ));

test('directChat fallback uses the same scoped history and writes only after its completion callback', () =>
  fixture(async f => {
    const a = await f.context(),
      b = await f.context('b');
    await f.registry.appendPrivateTurn(a, '__A_DIRECT_OLD__', 'a');
    await f.registry.appendPrivateTurn(b, '__B_DIRECT_OLD__', 'b');
    const oldFetch = globalThis.fetch;
    let completed = false;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.match(JSON.stringify(body.messages), /__B_DIRECT_OLD__/);
      assert.doesNotMatch(JSON.stringify(body.messages), /__A_DIRECT_OLD__/);
      return Response.json({ choices: [{ message: { content: '__B_DIRECT_NEW__' } }] });
    };
    try {
      await directChat(
        f.config,
        { apiKey: 'synthetic' },
        '__B_DIRECT_NOW__',
        new AbortController().signal,
        async () => {},
        b,
        async () => {
          assert.equal((await f.registry.privateHistory(b)).length, 2);
          completed = true;
        }
      );
      assert.equal(completed, true);
      assert.equal((await f.registry.privateHistory(b)).length, 4);
      assert.equal((await f.registry.privateHistory(a)).length, 2);
      assert.doesNotMatch(JSON.stringify(await f.registry.privateHistory(a)), /__B_DIRECT_NEW__/);
    } finally {
      globalThis.fetch = oldFetch;
    }
  }));
