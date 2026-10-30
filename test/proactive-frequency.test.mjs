import test from 'node:test';
import assert from 'node:assert/strict';
import { proactiveOptions, entitledProactiveOptions } from '../lib/proactive/options.js';

test('personal credentials preserve the selected cadence unless high frequency is explicitly selected', () => {
  for (const activity of ['quiet', 'balanced', 'active']) {
    const base = proactiveOptions({ modules: { settings: { proactive: { activity } } } });
    assert.equal(base.ownKeyMax, false);
    assert.deepEqual(entitledProactiveOptions(base), base);
  }
  const explicit = proactiveOptions({ modules: { settings: { proactive: { activity: 'quiet', ownKeyMax: true } } } });
  const high = entitledProactiveOptions(explicit);
  assert.equal(high.maxPerDay, 10);
  assert.deepEqual(high.quietHours, explicit.quietHours);
});
