import { Format, useEvent, useMessage } from 'alemonjs';
import { canReset, getConversationId } from '@src/response/dsh/util';
import { cancelChatForUser } from '@src/dsh/orchestrator';
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
  const privileged = canReset(event);
  let result = cancelChatForUser(channelId, userKey, privileged);

  const cancelledPending = groupConversations.cancelPending(channelId, userKey, privileged);

  if ((result === 'empty' || result === 'forbidden') && cancelledPending) {
    result = 'cancelled-queued';
  }
  const text = {
    'cancelled-running': '已取消正在生成的回复。',
    'cancelled-queued': '已取消你最后一条排队请求。',
    empty: '当前没有待处理请求。',
    forbidden: '这是其他成员的请求，请由本人或管理员取消。'
  }[result];

  await message.send({ format: Format.create().addMarkdownOriginal(text) });
};
