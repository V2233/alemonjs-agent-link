import { Format, useEvent, useMessage, useRoute } from 'alemonjs';
import { setAIEnabled } from '../../dsh/ai-switch';

export default async (): Promise<void> => {
  const [context] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();

  if (!context.match.selects || !route.matched) return;
  const [message] = useMessage();
  const event = context.current;
  const enabled = route.key === '开启';
  let text: string;

  try {
    if (enabled && route.rawArgs.length) throw new Error('开启用法：/开启');
    text = setAIEnabled(event.IsMaster === true, enabled, route.rawArgs.join(' '));
  } catch (error) {
    text =
      error instanceof Error && (error.message.startsWith('只有') || error.message.startsWith('关闭原因') || error.message.startsWith('开启用法'))
        ? error.message
        : 'AI 开关未能保存，请检查服务器配置文件。';
  }
  await message.send({ format: Format.create().addText(text) });
};
