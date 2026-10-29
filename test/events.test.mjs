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
test('评价按会话隔离、保留历史并持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'events-'));
  const path = join(dir, 'events.sqlite');
  let store = new EventStore(path);
  try {
    store.recordEvaluation('a', 'u', '认真');
    store.recordEvaluation('a', 'u', '更认真');
    assert.equal(store.evaluations('b').length, 0);
    store.close();
    store = new EventStore(path);
    assert.equal(store.evaluations('a').length, 2);
    assert.equal(store.evaluations('a')[0].quote, '更认真');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
    store.close();
    store = new EventStore(path);
    assert.equal(store.triggered('budget').length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('评价幂等、撤回不复活；节日前与当天分别去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'events-'));
  const store = new EventStore(join(dir, 'events.sqlite'));
  try {
    store.recordEvaluation('s', 'u', '靠谱', 'msg');
    store.recordEvaluation('s', 'u', '靠谱', 'msg');
    assert.equal(store.evaluations('s').length, 1);
    const row = store.evaluations('s')[0];
    store.revokeEvaluation(row.id, row.updatedAt);
    store.recordEvaluation('s', 'u', '靠谱', 'msg');
    assert.equal(store.evaluations('s').length, 0);
    assert.equal(store.evaluationHistory()[0].revoked, 1);
    assert.equal(store.match('你好').length, 0);
    const before = new Date('2026-12-25T00:00:00Z');
    store.confirmFestivalDelivery('s', '元旦有什么打算？', before);
    assert.equal(store.festivals(before, 's').length, 0);
    assert.equal(store.festivals(before, 'other').length, 1);
    const day = new Date('2026-12-31T16:00:00Z');
    assert.equal(store.festivals(day, 's')[0].days, 0);
    store.confirmFestivalDelivery('s', '元旦快乐', day);
    assert.equal(store.festivals(day, 's').length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
