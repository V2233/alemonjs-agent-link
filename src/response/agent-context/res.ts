import { commandBubble } from '../bubble';
import { useEvent, useMessage } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { buildRecentChatContext, getRecentMessages } from '@src/chat-context/store';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!eventContext.match.selects) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();

  if (event.IsPrivate || !event.ChannelId) {
    await message.send({
      format: commandBubble('/聊天参考 仅可在群聊中使用。', '近期聊天参考', {
        platform: event.Platform,
        actions: [{ label: '帮助', command: '/帮助 聊天' }]
      })
    });

    return;
  }

  try {
    const config = getDSHConfig();
    const recent = await getRecentMessages(
      event.ChannelId,
      {
        maxMessages: config.recentChatMaxMessages,
        windowSeconds: config.recentChatWindowSeconds,
        maxChars: config.recentChatMaxChars
      },
      config,
      event.MessageId
    );
    const previewBudget = Math.max(0, Math.min(config.recentChatSummaryMaxChars, config.maxMessageLength - 320));
    const preview = buildRecentChatContext(recent, previewBudget);

    await message.send({
      format: commandBubble(preview ? `近期聊天参考\n${preview}` : '暂无近期聊天参考。', '近期聊天参考', {
        platform: event.Platform,
        actions: [{ label: '刷新参考', command: '/聊天参考' }, ...(event.IsMaster || event.IsAdmin ? [{ label: '清除参考', command: '/聊天参考 清除' }] : [])]
      })
    });
  } catch {
    await message.send({ format: commandBubble('聊天参考暂不可用，请稍后重试。', '近期聊天参考', { platform: event.Platform }) });
  }
};
