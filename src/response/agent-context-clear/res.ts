import { getDSHConfig } from '@src/dsh/client';
import { Format, useEvent, useMessage } from 'alemonjs';
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
    await message.send({ format: Format.create().addMarkdownOriginal('/聊天参考 清除 仅可在群聊中使用。') });

    return;
  }

  if (!canReset(event)) {
    await message.send({ format: Format.create().addMarkdownOriginal('仅主人或群管理员可清除聊天参考。') });

    return;
  }

  await clearRecentMessages(event.ChannelId, getDSHConfig());
  await message.send({ format: Format.create().addMarkdownOriginal('聊天参考已清除，正式对话保留。') });
};
