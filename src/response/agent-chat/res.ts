import { Format, useEvent, useMessage, useRoute } from 'alemonjs';
import { runDSHChat } from '@src/response/dsh/chat';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();

  if (!eventContext.match.selects || !route.matched) {
    return;
  }

  const prompt = route.rawArgs.join(' ').trim();
  const [message] = useMessage();

  if (eventContext.current.IsPrivate || !eventContext.current.ChannelId) {
    await message.send({
      format: Format.create().addMarkdownOriginal('`/chat` 仅能在群里使用。请在群内 @机器人，或发送 `/chat 你的问题`。')
    });

    return;
  }

  if (!prompt) {
    await message.send({
      format: Format.create().addMarkdownOriginal('想问什么？例如：`/chat 帮我总结刚才的讨论`。')
    });

    return;
  }

  await runDSHChat(eventContext.current, prompt);
};
