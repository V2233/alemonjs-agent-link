import { Format, useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { SessionRegistry } from '@src/state/registry';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();
  const [message] = useMessage();

  if (!eventContext.match.selects || !route.matched) {
    return;
  }
  const event = eventContext.current;

  if (event.IsPrivate) {
    await message.send({ format: Format.create().addMarkdownOriginal('请到需要管理的目标群里使用 `/agentpolicy`。') });

    return;
  }

  if (!event.ChannelId || !event.IsMaster) {
    await message.send({ format: Format.create().addMarkdownOriginal('只有机器人主人可在群内管理 Agent 策略。') });

    return;
  }
  try {
    const registry = new SessionRegistry(getDSHConfig());
    const requested = String(route.rawArgs[0] || 'status');

    if (requested === 'status') {
      await message.send({
        format: Format.create().addMarkdownOriginal(`当前群策略：\`${await registry.policy(event.ChannelId)}\`\n该版本只提供隔离的纯对话能力。`)
      });

      return;
    }
    if (requested !== 'chat-only') {
      await message.send({ format: Format.create().addMarkdownOriginal('用法：/agentpolicy status | chat-only') });

      return;
    }
    await registry.setPolicy(event.ChannelId, 'chat-only');
    await message.send({ format: Format.create().addMarkdownOriginal('已将当前群策略设为 `chat-only`。') });
  } catch {
    await message.send({ format: Format.create().addMarkdownOriginal('策略暂时无法读取，请稍后再试。') });
  }
};
