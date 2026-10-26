import { Format, useEvent, useMessage, useRoute } from 'alemonjs';
import { runDSHChat } from '@src/response/dsh/chat';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();

  if (!context.match.selects || !route.matched) {
    return;
  }
  const text = route.rawArgs.join(' ').trim();

  if (!text && !context.current.MessageMedia?.length) {
    const [message] = useMessage();

    await message.send({ format: Format.create().addText('用法：/语音 你的问题。回复使用 AI 合成语音；不可用时发送文字。') });

    return;
  }
  await runDSHChat(context.current, text, { voice: true });
};
