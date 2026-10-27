import test from 'node:test';
import assert from 'node:assert/strict';
import { getDSHConfig, streamChat, toUserMessage } from '../lib/dsh/client.js';
import { assertAIEnabled, setAIEnabled } from '../lib/dsh/ai-switch.js';
import { budgetedFetch, assertBudgetAvailable, reserveWorkspaceText } from '../lib/billing/budget.js';

test('AI switch defaults and bounds are validated', () => {
  assert.equal(getDSHConfig({}).aiEnabled, true);
  for (const value of [{ aiEnabled: 'false' }, { aiDisabledReason: 123 }, { aiDisabledReason: 'x'.repeat(501) }]) assert.throws(() => getDSHConfig(value));
});

test('owner switch persists in app config, preserves unrelated settings, and blocks paid requests with stale snapshots', async () => {
  const previous = globalThis.__config;
  const oldFetch = globalThis.fetch;
  let writes = 0,
    requests = 0;
  const config = {
    path: '/tmp/fixture.yaml',
    value: { other: { retained: true }, 'alemonjs-agent-link': { model: 'test', apiKey: 'fixture' } },
    saveValue(value) {
      writes++;
      this.value = value;
    }
  };
  globalThis.__config = config;
  globalThis.fetch = async () => {
    requests++;
    throw new Error('must not request');
  };
  try {
    const snapshot = getDSHConfig();
    assert.throws(() => setAIEnabled(false, false, 'not owner'), /主人/);
    assert.equal(writes, 0);
    assert.match(setAIEnabled(true, false, '别登了，没钱了。'), /全局关闭/);
    assert.equal(config.value.other.retained, true);
    assert.equal(config.value['alemonjs-agent-link'].apiKey, 'fixture');
    assert.equal(getDSHConfig().aiEnabled, false);
    const disabled = error => {
      assert.equal(error.kind, 'disabled');
      assert.equal(toUserMessage(error), '别登了，没钱了。');
      return true;
    };
    assert.throws(() => assertAIEnabled(snapshot), disabled);
    await assert.rejects(budgetedFetch(snapshot, new URL('https://example.com'), {}), disabled);
    await assert.rejects(assertBudgetAvailable(snapshot), disabled);
    await assert.rejects(reserveWorkspaceText(snapshot, 'hello'), disabled);
    await assert.rejects(
      streamChat(snapshot, 'session', 'hello', async () => {}),
      disabled
    );
    const { classifyGroupReply } = await import('../lib/social/reply-gate.js');
    const verdict = await classifyGroupReply({ recent: [], messages: [] }, new AbortController().signal);
    assert.equal(verdict.reply, false);
    assert.equal(requests, 0);
    assert.match(setAIEnabled(true, true), /全局开启/);
    assert.doesNotThrow(() => assertAIEnabled(getDSHConfig()));
    const epoch = getDSHConfig().aiNoticeEpoch;
    assert.ok(epoch);
    setAIEnabled(true, false);
    assert.equal(getDSHConfig().aiNoticeEpoch, epoch);
    setAIEnabled(true, false, 'changed reason');
    assert.equal(getDSHConfig().aiNoticeEpoch, epoch);
    setAIEnabled(true, true);
    assert.notEqual(getDSHConfig().aiNoticeEpoch, epoch);
    assert.throws(() => setAIEnabled(true, false, 'x'.repeat(501)), /500/);
    setAIEnabled(true, false);
    assert.throws(() => assertAIEnabled(), /AI 暂时关闭/);
  } finally {
    globalThis.__config = previous;
    globalThis.fetch = oldFetch;
  }
});
