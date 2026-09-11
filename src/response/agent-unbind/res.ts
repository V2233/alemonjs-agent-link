import { Format, logger, useEvent, useMessage } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { removeDSHCredentials } from '@src/dsh/credentials';
import { configureDSHSupervisor } from '@src/dsh/supervisor';

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

  try {
    await removeDSHCredentials();
    configureDSHSupervisor(getDSHConfig(), null);
    await message.send({ format: Format.create().addMarkdownOriginal('已移除模型凭证。后续群聊不会再调用模型，直到主人重新私聊绑定。') });
  } catch (error) {
    logger.error({ err: error }, 'DSH credential removal failed');
    await message.send({ format: Format.create().addMarkdownOriginal('移除失败。请检查系统密钥库是否可用。') });
  }
};
