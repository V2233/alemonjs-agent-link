import { getDSHConfig } from '@src/dsh/client';
import { useEvent, useMessage } from 'alemonjs';
import { noticeBubble } from '../bubble';
import { clearRecentMessages } from '@src/chat-context/store';
import { canReset } from '@src/response/dsh/util';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!eventContext.match.selects) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();

  if (event.IsPrivate || !event.ChannelId) {
    await message.send({ format: noticeBubble('/聊天参考 清除 仅可在群聊中使用。', { platform: event.Platform, title: '聊天参考' }) });

    return;
  }

  if (!canReset(event)) {
    await message.send({
      format: noticeBubble('仅主人或群管理员可清除聊天参考。', {
        platform: event.Platform,
        title: '聊天参考',
        actions: [{ label: '帮助', command: '/帮助 聊天' }]
      })
    });

    return;
  }

  await clearRecentMessages(event.ChannelId, getDSHConfig());
  await message.send({
    format: noticeBubble('聊天参考已清除，正式对话保留。', {
      platform: event.Platform,
      title: '聊天参考',
      actions: [
        { label: '再次查看', command: '/聊天参考' },
        { label: '帮助', command: '/帮助 聊天' }
      ]
    })
  });
};
