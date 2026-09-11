import { Format, logger, useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { getDSHCredentials, saveDSHCredentials } from '@src/dsh/credentials';
import { listAvailableModels } from '@src/dsh/models';
import { configureDSHSupervisor } from '@src/dsh/supervisor';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: 'private.message.create' });
  const [route] = useRoute();

  if (!eventContext.match.selects || !route.matched) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();

  if (!event.IsMaster) {
    await message.send({ format: Format.create().addMarkdownOriginal('只有机器人主人可以切换全群模型。') });

    return;
  }

  const requestedModel = String(route.rawArgs[0] ?? '').trim();

  try {
    const credentials = await getDSHCredentials();

    if (!credentials) {
      await message.send({ format: Format.create().addMarkdownOriginal('尚未绑定模型凭证。请先发送 /agentbind <API_KEY> [BASE_URL]。') });

      return;
    }

    const config = getDSHConfig();

    if (!requestedModel) {
      await message.send({ format: Format.create().addMarkdownOriginal(`当前全局模型：\`${credentials.model || config.model}\`\n查看可用列表：/agentmodels`) });

      return;
    }

    const availableModels = await listAvailableModels(credentials);

    if (!availableModels.includes(requestedModel)) {
      await message.send({ format: Format.create().addMarkdownOriginal('该模型不在当前服务返回的可用列表中。请先使用 /agentmodels 查看。') });

      return;
    }

    const updatedCredentials = { ...credentials, model: requestedModel };

    await saveDSHCredentials(updatedCredentials);
    const supervisor = configureDSHSupervisor(config, updatedCredentials);

    void supervisor.start().catch(error => logger.error({ err: error }, 'DSH bridge restart after model change failed'));
    await message.send({
      format: Format.create().addMarkdownOriginal(`已切换全局模型为 \`${requestedModel}\`，正在重新加载 DSH。请稍后发送 /agentstatus 确认就绪。`)
    });
  } catch {
    await message.send({ format: Format.create().addMarkdownOriginal('模型切换失败。请检查模型服务、凭证和可用模型列表。') });
  }
};
