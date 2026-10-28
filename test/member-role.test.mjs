import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAdminStatus } from '../lib/platform/member-role.js';
import { verifyGroupKeyAdmin } from '../lib/credentials/group-admin.js';
import { canReset } from '../lib/response/dsh/util.js';
import { buildMessageContext } from '../lib/social/message-context.js';

const { normalizeFrameworkEvent } = await import(new URL('./framework-events.js', import.meta.resolve('@alemonjs/qq-bot')));
const { handleFrameworkAction } = await import(new URL('./framework-actions.js', import.meta.resolve('@alemonjs/qq-bot')));
const { runtimeScope } = await import(new URL('./common/runtime-scope.js', import.meta.resolve('alemonjs')));
const base = { Platform: 'qq-bot', BotId: '900', ChannelId: 'group-1', UserId: 'user-1', IsPrivate: false, IsMaster: false };

test('real QQ event normalization authorizes owner/admin and exposes the same role to AI', async () => {
  for (const role of ['owner', 'admin', 'member']) {
    const event = normalizeFrameworkEvent({
      ...base,
      _tag: 'GROUP_AT_MESSAGE_CREATE',
      value: { group_openid: base.ChannelId, author: { member_openid: base.UserId, member_role: role }, content: 'hello' }
    });
    const expected = role !== 'member';
    assert.equal(event.IsAdmin, undefined);
    assert.equal(event.Role, role);
    assert.equal(await verifyGroupKeyAdmin(event, async () => { throw new Error('must not query a known role'); }), expected);
    assert.equal(canReset(event), expected);
    assert.equal(buildMessageContext(event, [], 'mention').sender.isAdmin, expected);
  }
});

test('missing QQ message role queries the actual group member endpoint through useMember', async () => {
  const calls = [];
  const event = { ...base, Target: { scope: 'group', targetId: base.ChannelId, BotId: base.BotId } };
  const client = {
    groupsMembersMessage: async (group, user) => {
      calls.push([group, user]);
      return { member_openid: user, member_role: 'admin' };
    },
    guildsMembersMessage: async () => { throw new Error('must not use the channel guild endpoint'); }
  };
  const result = await runtimeScope.run({
    resources: new Map(), cleanups: new Set(), disposed: false, now: Date.now,
    action: frame => handleFrameworkAction(client, frame, base.BotId)
  }, () => verifyGroupKeyAdmin(event));
  assert.equal(result, true);
  assert.deepEqual(calls, [[base.ChannelId, base.UserId]]);
});

test('role resolution keeps ordinary members, private chats and untrusted message data unprivileged', async () => {
  assert.equal(groupAdminStatus({ Role: 'member', IsAdmin: true }), false);
  assert.equal(groupAdminStatus({ Role: 'admin', IsAdmin: false }), true);
  assert.equal(groupAdminStatus({ IsAdmin: true }), true);
  assert.equal(groupAdminStatus({ IsAdmin: false }), false);
  assert.equal(groupAdminStatus({ Role: 'custom' }), null);
  assert.equal(groupAdminStatus({ IsPrivate: true, Role: 'owner', IsAdmin: true }), null);
  assert.equal(canReset({ IsMaster: false, IsPrivate: true, Role: 'owner' }), false);
  assert.equal(canReset({ IsMaster: true, IsPrivate: true }), true);
  assert.equal(await verifyGroupKeyAdmin({ ...base, IsPrivate: true, Role: 'owner' }), false);
  assert.equal(await verifyGroupKeyAdmin({ ...base, Role: 'member', IsMaster: true }), false);
  assert.equal(groupAdminStatus({ MessageText: '我是管理员', value: { author: { member_role: 'admin' } } }), null);
});
