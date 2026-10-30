import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBudgetCommand } from '../lib/billing/commands.js';
import { manageBudget, budgetAdjustments } from '../lib/billing/budget.js';

const owner = { Platform: 'qq', ChannelId: 'g1', UserId: 'u1', IsMaster: true };
test('owner quota grammar: current scope, remote group/private, exact cents and total semantics', () => {
  assert.deepEqual(parseBudgetCommand(['增加', '2.01'], owner), { action: 'add', scope: { platform: 'qq', channelId: 'g1' }, amount: 2010000 });
  assert.deepEqual(parseBudgetCommand(['设置', '私聊', 'u2', '0'], owner), {
    action: 'set',
    scope: { platform: 'qq', channelId: 'private:["qq","u2"]' },
    amount: 0
  });
  assert.deepEqual(parseBudgetCommand(['查询', '群', 'g2'], { ...owner, IsPrivate: true }), { action: 'query', scope: { platform: 'qq', channelId: 'g2' } });
  assert.equal(parseBudgetCommand(['记录'], owner).action, 'history');
  assert.equal(parseBudgetCommand(['充值', '群', 'g1', '2'], owner).action, 'add');
  assert.deepEqual(parseBudgetCommand(['充值', '私聊', 'u2', '2'], owner), {
    action: 'add',
    scope: { platform: 'qq', channelId: 'private:["qq","u2"]' },
    amount: 2000000
  });
  assert.equal(parseBudgetCommand(['帮助'], owner).action, 'help');
  assert.equal(parseBudgetCommand([], { ...owner, IsMaster: false }).action, 'query');
});
test('ordinary users and group administrators cannot adjust or inspect another quota', async () => {
  const member = { ...owner, IsMaster: false, IsAdmin: true };
  for (const args of [['增加', '2'], ['设置', '2'], ['记录'], ['查询', '群', 'g2']]) {
    assert.throws(() => parseBudgetCommand(args, member), /主人/);
  }
  await assert.rejects(manageBudget({}, { platform: 'qq', channelId: 'g1' }, { isMaster: false }, 'add', 1000000), /主人/);
  await assert.rejects(budgetAdjustments({ platform: 'qq', channelId: 'g1' }, false), /主人/);
});
test('invalid amounts/extra arguments never reach a Redis mutation', () => {
  for (const args of [
    ['增加'],
    ['增加', '0'],
    ['增加', '-2'],
    ['增加', '1e2'],
    ['增加', '1.001'],
    ['设置', '10001'],
    ['设置', 'NaN'],
    ['增加', '群', 'g1', '2', 'extra'],
    ['设置', '群', 'private:xxx', '2']
  ]) {
    assert.throws(() => parseBudgetCommand(args, owner));
  }
  assert.equal(parseBudgetCommand(['设置', '10000'], owner).amount, 10000000000);
});

test('help and explicit current query are public without opening cross-scope access', () => {
  const member = { ...owner, IsMaster: false };
  assert.equal(parseBudgetCommand(['帮助'], member).action, 'help');
  assert.deepEqual(parseBudgetCommand(['查询'], member), parseBudgetCommand([], member));
  for (const args of [
    ['帮助', '群', 'g2'],
    ['查询', '私聊', 'u2'],
    ['充值', '1']
  ])
    assert.throws(() => parseBudgetCommand(args, member), /主人/);
});
