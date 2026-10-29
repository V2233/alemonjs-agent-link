import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryQueryContext } from '../lib/memory/query-context.js';
import { compressRecentMessages } from '../lib/chat-context/store.js';

test('short memory queries inherit only the same speaker, session generation and recent topic', () => {
  const queries = new MemoryQueryContext();
  const alice = { platform: 'qq', channelId: 'group', userId: 'alice', generation: 1 };
  queries.resolve(alice, '我想继续讨论游戏装备搭配', true, 0);
  assert.equal(queries.resolve({ ...alice, userId: 'bob' }, '我那个呢', true, 100), '我那个呢');
  assert.match(queries.resolve(alice, '然后呢', true, 200), /装备搭配/);
  assert.match(queries.resolve(alice, '还有呢', true, 300), /装备搭配/, 'short responses must not overwrite the substantive topic');
  assert.equal(queries.resolve({ ...alice, generation: 2 }, '然后呢', true, 400), '然后呢');
  assert.equal(queries.resolve({ ...alice, channelId: 'other' }, '然后呢', true, 400), '然后呢');
  assert.equal(queries.resolve(alice, '然后呢', true, 300000), '然后呢');
  queries.resolve(alice, '自动任务不能覆盖用户话题', false, 300001);
  assert.equal(queries.resolve(alice, '然后呢', true, 300002), '然后呢');
});

test('old important messages cannot exhaust the budget before latest corrections', () => {
  const old = Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, text: `待办问题${i}？${'旧背景'.repeat(100)}`, timestamp: i }));
  const messages = [...old, { id: 'new-1', text: '补充：不是生产环境', timestamp: 30 }, { id: 'new-2', text: '刚才说错了，是测试环境', timestamp: 31 }];
  const result = compressRecentMessages(messages, 35);
  assert.ok(result.some(item => item.id === 'new-1'));
  assert.ok(result.some(item => item.id === 'new-2'));
  assert.ok(result.reduce((n, item) => n + item.text.length, 0) <= 35);
  assert.deepEqual(
    result.map(item => item.timestamp),
    result.map(item => item.timestamp).sort((a, b) => a - b)
  );
  const duplicate = compressRecentMessages(
    [
      { text: '重复', timestamp: 1 },
      { text: '重复', timestamp: 10 }
    ],
    10
  );
  assert.equal(duplicate[0].timestamp, 10);
});

test('short factual corrections start their own recall topic', () => {
  const queries = new MemoryQueryContext();
  const scope = { platform: 'qq', channelId: 'group', userId: 'alice', generation: 1 };
  queries.resolve(scope, '我们聊一下游戏装备搭配', true, 0);
  assert.equal(queries.resolve(scope, '我不喝茶', true, 1), '我不喝茶');
  assert.equal(queries.resolve(scope, '然后呢', true, 2), '我不喝茶 然后呢');
});
