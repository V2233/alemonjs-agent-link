import test from 'node:test';
import assert from 'node:assert/strict';
import { Expose, registerExpose, withEventContext } from 'alemonjs';
import { present, presentationSchema } from './adapter.mjs';
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
const empty = { type: 'object', properties: {}, additionalProperties: false };
const envelope = (overrides = {}) => ({
  presentation: { mode: 'ai', delivery: 'pending', outcome: 'success', text: '境界：筑基初期；消耗：筑基丹2颗；剩余：3颗。', ...overrides }
});
const run = fn =>
  runtimeScope.run({ resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now }, () =>
    withEventContext({ name: 'message.create', Platform: 'qq-bot', UserId: '100' }, () => {}, fn, { appName: 'alemonjs-agent-link' })
  );

test('real Expose strips extra metadata but preserves validated output envelope', () =>
  run(async () => {
    let executions = 0;
    registerExpose('experiment-game', [
      {
        name: 'experiment.game.v1',
        description: '实验修仙插件，无真实玩家',
        actions: {
          breakthrough: {
            description: '模拟突破',
            effect: 'write',
            presentation: { mode: 'ai' },
            inputSchema: empty,
            outputSchema: { type: 'object', additionalProperties: false, properties: { presentation: presentationSchema }, required: ['presentation'] },
            authorize: () => true,
            handler: () => {
              executions++;
              return envelope();
            }
          }
        }
      }
    ]);
    const client = Expose.create();
    assert.equal(client.list()[0].actions.breakthrough.presentation, undefined);
    const receipt = await client.call('experiment.game.v1', 'experiment-game', 'breakthrough', {});
    assert.equal(receipt.ok, true);
    const result = await present(receipt, async () => '成了，这一步总算迈过去了。');
    assert.ok(result.text.endsWith(receipt.data.presentation.text));
    assert.equal(result.generated, true);
    const fallback = await present(receipt, async () => {
      throw new Error('model unavailable');
    });
    assert.ok(fallback.text.endsWith(receipt.data.presentation.text));
    assert.equal(fallback.generated, false);
    assert.equal(executions, 1);
  }));

for (const delivery of ['sent', 'unknown'])
  test(`delivery=${delivery} suppresses narration`, async () => {
    const result = await present({ ok: true, data: envelope({ delivery }) }, () => {
      throw new Error('must not call');
    });
    assert.equal(result.generated, false);
    assert.equal(result.kind, delivery === 'sent' ? 'already_sent' : 'delivery_unknown');
  });
for (const outcome of ['failure', 'partial', 'unknown'])
  test(`outcome=${outcome} stays literal`, async () => {
    let calls = 0;
    const result = await present({ ok: true, data: envelope({ outcome, text: '本次业务结果待核对。' }) }, () => {
      calls++;
    });
    assert.equal(calls, 0);
    assert.match(result.text, /本次业务结果待核对/);
  });
test('legacy and failed receipts retain separate paths', async () => {
  assert.equal((await present({ ok: true, data: { hp: 42 } })).kind, 'legacy');
  assert.equal((await present({ ok: false, error: { outcome: 'unknown' } })).kind, 'error');
  assert.equal((await present({ ok: true, data: envelope({ mode: 'raw' }) })).generated, false);
});
test('fixed result does not make unrestricted generated text factually safe', async () => {
  const result = await present({ ok: true, data: envelope() }, async () => '额外获得一万灵石。');
  assert.match(result.text, /额外获得一万灵石/);
  assert.ok(result.text.endsWith(envelope().presentation.text));
  // Deliberately documents the limitation: preservation is not hallucination prevention.
});
