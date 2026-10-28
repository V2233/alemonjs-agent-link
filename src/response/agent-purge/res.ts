import { commandBubble } from '../bubble';
import { logger, useEvent, useMessage, useRoute } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { purgeGroupSession } from '@src/dsh/orchestrator';

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
    await message.send({
      format: commandBubble('请到需要清理的目标群里使用 /清除群数据。', '清除群数据', {
        platform: event.Platform,
        actions: [{ label: '清除群数据', command: '/清除群数据' }]
      })
    });

    return;
  }

  if (!event.ChannelId || !event.IsMaster) {
    await message.send({ format: commandBubble('仅机器人主人可清除群数据。', '清除群数据', { platform: event.Platform }) });

    return;
  }

  const actor = event.UserKey || 'master';
  const confirmation = confirmations.get(event.ChannelId);
  const confirmed = ['confirm', '确认'].includes(String(route.rawArgs[0] ?? '').toLowerCase());

  if (!confirmed) {
    confirmations.set(event.ChannelId, { actor, expiresAt: Date.now() + confirmationTtlMs });
    await message.send({
      format: commandBubble('将永久删除本群会话、文件、聊天记录、记忆及本群人格和心情设置，无法恢复。\n请本人在60秒内发送 /清除群数据 确认。', '清除群数据', {
        platform: event.Platform,
        actions: [
          { label: '确认清除', command: '/清除群数据 确认', choice: 'binary' },
          { label: '取消', command: '/取消', choice: 'binary' }
        ]
      })
    });

    return;
  }

  if (confirmation?.actor !== actor || (confirmation?.expiresAt ?? 0) < Date.now()) {
    confirmations.delete(event.ChannelId);
    await message.send({
      format: commandBubble('确认已过期或不匹配。请先重新发送 /清除群数据。', '清除群数据', {
        platform: event.Platform,
        actions: [{ label: '重新发起', command: '/清除群数据' }]
      })
    });

    return;
  }

  confirmations.delete(event.ChannelId);

  try {
    const config = getDSHConfig();

    await purgeGroupSession(event.ChannelId, config);
    await message.send({ format: commandBubble('本群数据已彻底清除。', '清除群数据') });
  } catch (error) {
    logger.error({ err: error }, 'Agent group data purge failed');
    await message.send({
      format: commandBubble('清理未完成，请核对后重试。', '清除群数据', {
        platform: event.Platform,
        actions: [{ label: '重试清除', command: '/清除群数据' }]
      })
    });
  }
};
