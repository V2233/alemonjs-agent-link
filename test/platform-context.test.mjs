import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOneBotEvent } from '../lib/onebot/events.js';
import { buildMessageContext } from '../lib/social/message-context.js';

const raw = { self_id: 900, post_type: 'notice', group_id: 200, user_id: 100, operator_id: 300, time: 1000, message_id: 10 };
const normalize = extra => normalizeOneBotEvent({ ...raw, ...extra }, '900', () => false);

test('OneBot notices preserve actor, subject and specific action, rather than treating every member as the speaker', () => {
  assert.deepEqual(normalize({ notice_type: 'group_recall' }).PlatformAction, { kind: 'recall', actorId: '300', subjectId: '100' });
  assert.deepEqual(normalize({ notice_type: 'group_ban', duration: 60 }).PlatformAction, {
    kind: 'ban',
    actorId: '300',
    subjectId: '100',
    durationSeconds: 60
  });
  assert.equal(normalize({ notice_type: 'group_decrease', sub_type: 'kick' }).PlatformAction.kind, 'member_kick');
  assert.equal(normalize({ notice_type: 'group_decrease', sub_type: 'leave' }).PlatformAction.kind, 'member_leave');
  assert.equal(normalize({ notice_type: 'group_admin', sub_type: 'set' }).PlatformAction.kind, 'admin_set');
  const card = normalize({ notice_type: 'group_card', card_old: '旧名字', card_new: '新名字', operator_id: undefined });
  assert.equal(card.PlatformAction.actorId, undefined);
  assert.equal(buildMessageContext(card, [], 'platform_event').platformAction.newName, '新名字');
});

test('OneBot distinguishes everyone mention and unknown platform timestamp', () => {
  const event = normalize({ post_type: 'message', message_type: 'group', message: [{ type: 'at', data: { qq: 'all' } }], time: undefined });
  const context = buildMessageContext(event, event.MessageMentions, 'ambient');
  assert.equal(context.mentionEveryone, true);
  assert.equal(context.mentionedSelf, false);
  assert.equal(context.time.occurredAt, null);
});
