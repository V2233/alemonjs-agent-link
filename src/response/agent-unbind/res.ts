import { Format, useEvent, useMessage } from 'alemonjs';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: 'private.message.create' });

  if (!eventContext.match.selects) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();

  if (!event.IsMaster) {
    await message.send({ format: Format.create().addMarkdownOriginal('只有机器人主人可以移除全群共用的模型凭证。') });

    return;
  }

  await message.send({
    format: Format.create().addMarkdownOriginal('请从 `alemon.config.yaml` 的 `alemonjs-agent-link.apiKey` 移除凭证后重启服务。')
  });
};
