import { Format, logger, useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { purgeSessionData } from '@src/dsh/client';
import { cancelGroupChat } from '@src/dsh/orchestrator';
import { SessionRegistry } from '@src/state/registry';

const confirmationTtlMs = 60_000;
const confirmations = new Map<string, { actor: string; expiresAt: number }>();

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });
  const [route] = useRoute();
  const [message] = useMessage();

  if (!eventContext.match.selects || !route.matched) {
    return;
  }
  const event = eventContext.current;

  if (event.IsPrivate) {
    await message.send({ format: Format.create().addMarkdownOriginal('请到需要清理的目标群里使用 `/agentpurge`。') });

    return;
  }

  if (!event.ChannelId || !event.IsMaster) {
    await message.send({ format: Format.create().addMarkdownOriginal('只有机器人主人可清除当前群的 Agent 数据。') });

    return;
  }

  const actor = event.UserKey || 'master';
  const confirmation = confirmations.get(event.ChannelId);
  const confirmed = String(route.rawArgs[0] ?? '').toLowerCase() === 'confirm';

  if (!confirmed) {
    confirmations.set(event.ChannelId, { actor, expiresAt: Date.now() + confirmationTtlMs });
    await message.send({
      format: Format.create().addMarkdownOriginal(
        '## 即将彻底删除本群数据\n会删除 Agent 会话、工作区和近期聊天参考，且无法恢复。\n\n请由你本人在 **60 秒内** 发送：`/agentpurge confirm`'
      )
    });

    return;
  }

  if (confirmation?.actor !== actor || (confirmation?.expiresAt ?? 0) < Date.now()) {
    confirmations.delete(event.ChannelId);
    await message.send({ format: Format.create().addMarkdownOriginal('确认已过期或不匹配。请先重新发送 `/agentpurge`。') });

    return;
  }

  confirmations.delete(event.ChannelId);

  try {
    const config = getDSHConfig();
    const registry = new SessionRegistry(config);

    await registry.ready();
    cancelGroupChat(event.ChannelId);
    await purgeSessionData(config, `dsh:qq:group:${event.ChannelId}`);
    await registry.purgeHash(await registry.groupKey(event.ChannelId));
    await message.send({ format: Format.create().addMarkdownOriginal('## 已删除\n当前群的 Agent 会话、工作区与近期聊天参考已彻底清除。') });
  } catch (error) {
    logger.error({ err: error }, 'Agent group data purge failed');
    await message.send({ format: Format.create().addMarkdownOriginal('操作暂时未完成，请稍后再试。') });
  }
};
