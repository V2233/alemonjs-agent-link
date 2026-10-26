import { Format, useEvent, useMessage, useRoute, useMedia } from 'alemonjs';
import { runDSHChat } from '@src/response/dsh/chat';
import { submitGroupChat } from '../../social/respond';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();

  if (!context.match.selects || !route.matched || context.current.IsBot) {
    return;
  }
  const text = route.rawArgs.join(' ').trim();

  if (!text && !context.current.MessageMedia?.length) {
    const [message] = useMessage();

    await message.send({ format: Format.create().addText('用法：/语音 你的问题。回复使用 AI 合成语音；不可用时发送文字。') });

    return;
  }
  if (context.current.IsPrivate) {
    await runDSHChat(context.current, text, { voice: true });
  } else {
    const [message] = useMessage();
    const [media] = useMedia();

    try {
      await submitGroupChat(context.current, text, { message, media }, true);
    } catch {
      await message.send({ format: Format.create().addText('群聊消息暂时无法处理，请稍后重试。') });
    }
  }
};
