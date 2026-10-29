import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../lib/events/store.js';
import { upcomingFestival } from '../lib/modules/events.js';
test('节日前七天按上海日期判断，跨年正确', () => {
  assert.equal(upcomingFestival(new Date('2026-12-31T16:00:00Z')), '');
  assert.match(upcomingFestival(new Date('2026-12-25T00:00:00Z')), /元旦将在7天/);
});
test('评价按会话隔离、按发言人更新并持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'events-'));
  const path = join(dir, 'events.sqlite');
  let store = new EventStore(path);
  try {
    store.recordEvaluation('a', 'u', '认真');
    store.recordEvaluation('a', 'u', '更认真');
    assert.equal(store.evaluations('b').length, 0);
    store.close(); store = new EventStore(path);
    assert.equal(store.evaluations('a').length, 1);
    assert.equal(store.evaluations('a')[0].quote, '更认真');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('默认事件只初始化一次，停用节日生效且日期校验严格', () => {
  const dir = mkdtempSync(join(tmpdir(), 'events-'));
  const path = join(dir, 'events.sqlite');
  let store = new EventStore(path);
  try {
    const budget = store.triggered('budget')[0];
    assert.ok(budget.fallback);
    store.remove(budget.id, budget.updatedAt);
    const festival = store.festivals(new Date('2026-12-25T00:00:00Z'))[0];
    assert.equal(festival.days, 7);
    store.save({ ...festival.event, enabled: false });
    assert.equal(store.festivals(new Date('2026-12-25T00:00:00Z')).length, 0);
    assert.throws(() => store.save({ ...festival.event, date: '02-30' }), /日期/);
    store.close(); store = new EventStore(path);
    assert.equal(store.triggered('budget').length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
