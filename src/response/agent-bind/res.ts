import { Format, useEvent, useMessage } from 'alemonjs';
import { personalKeyGuide } from '../../billing/help';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: 'private.message.create' });

  if (!eventContext.match.selects) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();

  if (!event.IsMaster) {
    await message.send({ format: Format.create().addText(`公共密钥仅限机器人主人配置。个人使用请按下面操作：\n\n${personalKeyGuide}`) });

    return;
  }

  await message.send({
    format: Format.create().addText('在 alemon.config.yaml 的 alemonjs-agent-link 中填写 apiKey，可选填 baseUrl。保存即生效，请勿在聊天中发送公共密钥。')
  });
};
