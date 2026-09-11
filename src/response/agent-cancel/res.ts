import { Format, useEvent, useMessage } from 'alemonjs';
import { cancelChatForUser } from '@src/dsh/orchestrator';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: 'message.create' });

  if (!eventContext.match.selects) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();

  if (!event.ChannelId) {
    return;
  }

  const result = cancelChatForUser(event.ChannelId, event.UserKey || 'unknown', event.IsMaster || Boolean(event.IsAdmin));
  const text = {
    'cancelled-running': '已取消正在生成的回复。',
    'cancelled-queued': '已取消你最后一条排队请求。',
    empty: '当前没有正在处理或排队的请求。',
    forbidden: '当前回复属于其他成员；请让发起者取消，或请管理员处理。'
  }[result];

  await message.send({ format: Format.create().addMarkdownOriginal(text) });
};
