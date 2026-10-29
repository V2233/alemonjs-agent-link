import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyBrowseSlot, browseWindow } from '../lib/proactive/browse-schedule.js';
import { ProactiveStore } from '../lib/proactive/store.js';
import { proactiveOptions } from '../lib/proactive/options.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scope = { platform: 'onebot', botId: '900', userId: '100' };

test('reading window is stable, monotonic within a window, timezone aware and bounded', () => {
  for (const value of [[1, 1], [-1, 22], [18, 24], [18.5, 22], '18-22']) assert.throws(() => browseWindow(value));
  assert.equal(browseWindow(undefined), undefined);
  const start = Date.parse('2026-10-29T18:00:00+08:00');
  const values = Array.from({ length: 240 }, (_, minute) => dailyBrowseSlot(scope, start + minute * 60000, 'Asia/Shanghai', [18, 22]).due);
  assert.equal(values.at(-1), true);
  const first = values.indexOf(true);
  assert.ok(values.slice(0, first).every(value => !value));
  assert.ok(values.slice(first).every(Boolean));
  assert.deepEqual(
    dailyBrowseSlot(scope, start + first * 60000, 'Asia/Shanghai', [18, 22]),
    dailyBrowseSlot(scope, start + first * 60000, 'Asia/Shanghai', [18, 22])
  );
  assert.equal(dailyBrowseSlot(scope, start - 60000, 'Asia/Shanghai', [18, 22]).due, false);
  assert.equal(dailyBrowseSlot(scope, start + 240 * 60000, 'Asia/Shanghai', [18, 22]).due, false);
  assert.equal(dailyBrowseSlot(scope, Date.parse('2026-10-29T21:59:00Z'), 'UTC', [18, 22]).due, true);
});

test('cross-midnight activity uses its start date and cannot claim twice after midnight or restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browse-window-'));
  let now = Date.parse('2026-10-29T23:59:00+08:00');
  const options = { ...proactiveOptions({}), quietHours: [0, 0] };
  let store = new ProactiveStore(root, () => now);
  try {
    store.subscribe(scope, true, options);
    const beforeMidnight = store.claimDailyBrowse(scope, options, [22, 2]);
    now = Date.parse('2026-10-30T01:59:00+08:00');
    assert.deepEqual(dailyBrowseSlot(scope, now, 'Asia/Shanghai', [22, 2]), { day: '2026-10-29', due: true });
    assert.equal(store.claimDailyBrowse(scope, options, [22, 2]), !beforeMidnight);
    store.close();
    store = new ProactiveStore(root, () => now);
    assert.equal(store.claimDailyBrowse(scope, options, [22, 2]), false);
    now = Date.parse('2026-10-30T02:00:00+08:00');
    assert.equal(store.claimDailyBrowse(scope, options, [22, 2]), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
