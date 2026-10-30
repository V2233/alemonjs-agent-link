import { useEvent, useMessage } from 'alemonjs';
import { noticeBubble } from '../bubble';
import { canManageConversation, getConversationId } from '@src/response/dsh/util';
import { getDSHConfig } from '../../dsh/runtime-config';
import { cancelChatForUser, conversationQueueScope } from '@src/dsh/orchestrator';
import { groupConversations } from '../../social/groups';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!eventContext.match.selects) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();

  const channelId = getConversationId(event);

  if (!channelId) {
    return;
  }

  const userKey = event.UserKey || event.UserId || 'unknown';
  const privileged = await canManageConversation(event);
  let result = cancelChatForUser(channelId, userKey, privileged, conversationQueueScope(getDSHConfig(), { platform: event.Platform, botId: event.BotId }));

  const cancelledPending = groupConversations.cancelPending(channelId, userKey, privileged, { platform: event.Platform, botId: event.BotId });

  if ((result === 'empty' || result === 'forbidden') && cancelledPending) {
    result = 'cancelled-queued';
  }
  const text = {
    'cancelled-running': '好，这条我不继续写了。',
    'cancelled-queued': '好，你最后一条排队的提问已经撤掉了。',
    empty: '现在没有待处理的提问了。',
    forbidden: '这是其他成员的提问，需要由本人或管理员来取消。'
  }[result];

  await message.send({
    format: noticeBubble(text, {
      platform: eventContext.current.Platform,
      title: '取消',
      actions: [
        { label: '重新提问', command: '/提问' },
        { label: '帮助', command: '/帮助 聊天' }
      ]
    })
  });
};
