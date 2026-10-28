import assert from 'node:assert/strict';
import test from 'node:test';
import { poolPageView } from '../lib/response/agent-pool/format.js';

const base = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  capabilities: ['chat'],
  fallback: false,
  priority: 0,
  bound: 0,
  requests: 0,
  tokens: 0,
  dailyRequests: 0,
  dailyTokens: 0,
  recent: 0,
  weight: 1,
  maxConcurrent: 2,
  active: 0,
  failures: 0,
  cooldownUntil: 0,
  disabled: false,
  disabledUntil: 0,
  latencyMs: 100,
  healthy: true,
  lastProbeAt: 1,
  lastStatus: 200
};

test('pool page shows a summary, refill hint and paginates five rows', () => {
  const items = Array.from({ length: 7 }, (_, index) => ({ ...base, id: `key-${index + 1}` }));
  items[1] = { ...items[1], disabled: true };
  items[2] = { ...items[2], cooldownUntil: 9999 };
  items[3] = { ...items[3], healthy: false };

  const balances = new Map([
    ['key-1', { text: '¥20.00', amount: 20, currency: 'CNY', checkedAt: 1000 }],
    ['key-2', { text: '未收录', checkedAt: 1000 }],
    ['key-3', { text: '¥1.50', amount: 1.5, currency: 'CNY', checkedAt: 1000 }]
  ]);
  const bridge = {
    date: '2026-10-28',
    endpoints: { 'key-1': { requests: 2, input: 10, output: 5 } },
    personal: { requests: 1, input: 4, output: 1 }
  };
  const first = poolPageView(items, 1, 1000, balances, 5, bridge);
  assert.equal(first.page, 1);
  assert.equal(first.pages, 2);
  assert.equal(first.disabled, 1);
  assert.equal(first.cooling, 1);
  assert.equal(first.available, 5);
  assert.equal(first.abnormal, 1);
  assert.match(first.text, /模型池 1\/2/);
  assert.match(first.text, /停用/);
  assert.match(first.text, /补货提示/);
  assert.match(first.text, /余额 ¥20.00/);
  assert.match(first.text, /余额 未收录/);
  assert.match(first.text, /低余额 1/);
  assert.match(first.text, /及时补货/);
  assert.match(first.text, /沙箱 2 次\/15 tok/);
  assert.match(first.text, /个人\/群 1 次\/5 tok/);
  assert.equal(first.text.split('\n').filter(line => /^\d+\. key-/u.test(line)).length, 5);

  const second = poolPageView(items, 2, 1000);
  assert.equal(second.page, 2);
  assert.equal(second.text.split('\n').filter(line => /^\d+\. key-/u.test(line)).length, 2);
  assert.doesNotMatch(second.text, /key-1 /);
});

test('pool page clamps invalid page numbers', () => {
  const items = Array.from({ length: 2 }, (_, index) => ({ ...base, id: `key-${index + 1}` }));
  assert.equal(poolPageView(items, 99).page, 1);
  assert.equal(poolPageView(items, 0).page, 1);
  assert.equal(poolPageView([], 2).pages, 1);
});
