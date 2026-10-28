import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDSHConfig } from '../lib/dsh/client.js';
import { SessionRegistry, buildHistoryDigest } from '../lib/state/registry.js';

const channelId = 'private:one';

const fixture = async (overrides, run) => {
  const root = await mkdtemp(join(tmpdir(), 'history-'));
  const original = globalThis.__config;
  globalThis.__config = {
    value: {
      'alemonjs-agent-link': {
        apiKey: 'test',
        model: 'test',
        runtimeMode: 'chat-only',
        stateBackend: 'local',
        workspaceRoot: join(root, 'work'),
        dshHomeRoot: join(root, 'home'),
        ...overrides
      }
    }
  };
  try {
    await run({ config: getDSHConfig() });
  } finally {
    globalThis.__config = original;
    await rm(root, { recursive: true, force: true });
  }
};

const isolate = async (registry, channelId) => {
  const reset = await registry.beginReset(channelId);
  assert.equal(await registry.completeReset(channelId, reset.operationId), true);
  return { channelId, generation: reset.generation };
};

test('history stays append-only between compactions so the cached prefix survives', () =>
  fixture({ privateHistoryMaxTurns: 10, privateHistoryMaxChars: 4000 }, async ({ config }) => {
    const registry = new SessionRegistry(config);
    const context = await isolate(registry, channelId);

    for (const [index, text] of ['第一轮', '第二轮', '第三轮'].entries()) {
      await registry.appendPrivateTurn(context, `问题${index}：${text}`, `回答${index}：${text}`);
    }
    const first = await registry.privateHistory(context);
    assert.equal(first.length, 6);
    // Reading must not move the window: a repeated read has to be byte-identical.
    assert.deepEqual(await registry.privateHistory(context), first);

    await registry.appendPrivateTurn(context, '问题3：第四轮', '回答3：第四轮');
    const next = await registry.privateHistory(context);
    // Everything the previous turn saw is still the exact prefix of this turn.
    assert.deepEqual(next.slice(0, first.length), first);
    assert.deepEqual(
      next.slice(-2).map(message => message.content),
      ['问题3：第四轮', '回答3：第四轮']
    );
  }));

test('overflow folds older turns into one stable digest and keeps the prefix stable', () =>
  fixture({ privateHistoryMaxTurns: 10, privateHistoryMaxChars: 240 }, async ({ config }) => {
    const registry = new SessionRegistry(config);
    const context = await isolate(registry, channelId);

    // Each turn is short enough to be stored but the tail overflows the budget.
    const ask = index => `用户消息编号${index}，这里再补一句让长度明显超过阈值`;
    const reply = index => `助手回应编号${index}，同样补上一句让长度继续增加`;

    for (let index = 0; index < 8; index += 1) {
      await registry.appendPrivateTurn(context, ask(index), reply(index));
    }
    const compacted = await registry.privateHistory(context);
    assert.equal(compacted[0].role, 'system');
    assert.match(compacted[0].content, /早前对话摘要/u);
    assert.ok(compacted.length < 9, 'older turns must not be sent verbatim once they overflow');
    assert.match(compacted[0].content, /编号0|编号1|编号2/u);
    // Compaction is one-shot: the same state must not re-summarise on every read.
    assert.deepEqual(await registry.privateHistory(context), compacted);

    await registry.appendPrivateTurn(context, ask(8), reply(8));
    const after = await registry.privateHistory(context);
    assert.deepEqual(after.slice(0, compacted.length), compacted);
    assert.equal(after.at(-1).content, reply(8));
  }));

test('a reset clears the digest so an old topic cannot follow the user forward', () =>
  fixture({ privateHistoryMaxTurns: 10, privateHistoryMaxChars: 240 }, async ({ config }) => {
    const registry = new SessionRegistry(config);
    const context = await isolate(registry, channelId);

    for (let index = 0; index < 5; index += 1) {
      await registry.appendPrivateTurn(context, `旧话题${index}`, `旧回答${index}`);
    }
    assert.match((await registry.privateHistory(context))[0].content, /旧话题/);
    const reset = await isolate(registry, channelId);
    assert.deepEqual(await registry.privateHistory(reset), []);
  }));

test('digest keeps the newest turns, stays under the limit and marks autonomous turns', () => {
  const dropped = Array.from({ length: 40 }, (_, index) => ({
    user: `用户第${index}条消息内容比较长需要被截断处理`,
    assistant: `助手第${index}条回复内容同样很长也需要截断`
  }));
  const digest = buildHistoryDigest('', dropped);

  assert.ok(digest.length <= 1200);
  assert.match(digest.trimEnd(), /用户第39条/u);
  assert.doesNotMatch(digest, /用户第0条/u);
  assert.match(buildHistoryDigest('', [{ user: '', assistant: '主动开口', autonomous: true }]), /你主动说过/u);
});
