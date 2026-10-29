import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAds } from '../lib/ads/config.js';
import { claimAdvertisementReward } from '../lib/billing/budget.js';
const ad = { id: 'demo', title: '演示', content: '广告内容', enabled: true, rewardYuan: 0.01 };
test('advertisements default to disabled and accept explicit enable', () => {
  assert.deepEqual(parseAds(), { enabled: false, items: [] });
  assert.equal(parseAds({ items: [ad] }).enabled, false);
  assert.equal(parseAds({ enabled: true, items: [ad] }).items[0].rewardYuan, 0.01);
});
test('duplicate ids, invalid rewards and unsafe links fail even while off', () => {
  assert.throws(() => parseAds({ enabled: false, items: [ad, ad] }));
  for (const rewardYuan of [0, -1, 10.01, 0.001, NaN, '1']) assert.throws(() => parseAds({ items: [{ ...ad, rewardYuan }] }));
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://u:p@example.com']) assert.throws(() => parseAds({ items: [{ ...ad, url }] }));
});
test('reward rejects group scopes and spoofed private identity before touching ledger', async () => {
  for (const channelId of ['group', 'private:other'])
    await assert.rejects(claimAdvertisementReward({ budget: { enabled: true } }, { platform: 'test', userId: 'u', channelId }, 'demo', 10000));
});
