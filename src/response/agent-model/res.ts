import { Format, useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: 'private.message.create' });
  const [route] = useRoute();

  if (!eventContext.match.selects || !route.matched) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();

  if (!event.IsMaster) {
    await message.send({ format: Format.create().addText('公共模型仅限机器人主人设置。') });

    return;
  }

  const requestedModel = String(route.rawArgs[0] ?? '').trim();

  const config = getDSHConfig();

  await message.send({
    format: Format.create().addText(
      requestedModel ? `请将配置中的 alemonjs-agent-link.model 改为 ${requestedModel}，保存即生效。` : `当前模型：${config.model}\n查看可用列表：/模型列表`
    )
  });
};
