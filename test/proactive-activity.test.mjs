import test from 'node:test';
import assert from 'node:assert/strict';
import { entitledProactiveOptions, proactiveOptions } from '../lib/proactive/options.js';

test('proactive defaults to the active cadence for a most-active dafeiyu', () => {
  const options = proactiveOptions({ modules: { settings: { proactive: {} } } });

  assert.equal(options.activity, 'active');
  assert.equal(options.idleMinutes, 20);
  assert.equal(options.minIntervalMinutes, 30);
  assert.equal(options.maxIntervalMinutes, 90);
  assert.equal(options.maxPerDay, 8);
  assert.equal(options.nudgeChance, 0.6);
  assert.equal(options.maxNudgesPerDay, 6);
  assert.equal(options.maxUnanswered, 3);
  assert.equal(options.ownKeyMax, false);
  assert.deepEqual(entitledProactiveOptions(options), options);
  assert.equal(entitledProactiveOptions({...options,ownKeyMax:true}).flexible, true);
});

test('quiet cadence and explicit numeric overrides are respected', () => {
  const quiet = proactiveOptions({ modules: { settings: { proactive: { activity: 'quiet' } } } });
  assert.equal(quiet.activity, 'quiet');
  assert.equal(quiet.idleMinutes, 90);
  assert.equal(quiet.maxPerDay, 2);

  const tuned = proactiveOptions({ modules: { settings: { proactive: { activity: 'quiet', idleMinutes: 5, maxPerDay: 1 } } } });
  assert.equal(tuned.activity, 'quiet');
  assert.equal(tuned.idleMinutes, 5);
  assert.equal(tuned.maxPerDay, 1);
  assert.equal(tuned.minIntervalMinutes, 180);
});

test('invalid proactive activity is rejected', () => {
  assert.throws(() => proactiveOptions({ modules: { settings: { proactive: { activity: 'hyper' } } } }), /proactive 模块设置无效/u);
});
