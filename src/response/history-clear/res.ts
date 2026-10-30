import { commandBubble } from '../bubble';
import { useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '../../dsh/client';
import { canPrivateChatWithKey, getConversationId } from '../dsh/util';
import { getChatArchive } from '../../history/store';
const confirmations = new Map<string, number>();

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();
  const [message] = useMessage();

  if (!context.match.selects || !route.matched) {
    return;
  }
  const event = context.current;
  const reply = (text: string) =>
    message.send({
      format: commandBubble(text, '清除聊天记录', {
        platform: event.Platform,
        actions: [
          { label: '清除聊天记录', command: '/清除聊天记录' },
          { label: '隐私说明', command: '/隐私说明' }
        ]
      })
    });
  const config = getDSHConfig();

  if (event.IsPrivate ? !(await canPrivateChatWithKey(event, config.privateChatAccess)) : !event.IsMaster) {
    await reply('仅可清除自己的私聊记录；群归档需由机器人主人清除。');

    return;
  }
  const channelId = getConversationId(event);

  if (!channelId || !event.Platform || !event.UserId) {
    await reply('无法识别当前会话。');

    return;
  }
  const key = JSON.stringify([event.Platform, event.BotId || '', channelId, event.UserId]);

  for (const [id, expires] of confirmations) {
    if (expires <= Date.now()) {
      confirmations.delete(id);
    }
  }
  if (route.rawArgs[0] !== 'confirm') {
    if (confirmations.size >= 1000) {
      await reply('请求过多，请稍后重试。');

      return;
    }
    confirmations.set(key, Date.now() + 60000);
    await reply('将永久删除当前会话的聊天记录，保留记忆和当前对话。\n60秒内发送 /清除聊天记录 confirm 确认。');

    return;
  }
  if ((confirmations.get(key) ?? 0) <= Date.now()) {
    await reply('请先发送 /清除聊天记录，再于60秒内确认。');

    return;
  }
  confirmations.delete(key);
  try {
    getChatArchive(config).purge({ platform: event.Platform, channelId, botId: event.BotId || '' });
    await reply('聊天记录已清除，新消息仍会记录。');
  } catch {
    await reply('归档删除失败，请稍后重试。');
  }
};
