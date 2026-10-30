import { commandExpression } from '../../companion/command-expression';
import { logger, useEvent, useMessage } from 'alemonjs';
import { noticeBubble } from '../bubble';
import { getDSHConfig, toUserMessage } from '@src/dsh/client';
import { canManageConversation, getSessionId, getConversationId, canPrivateChatWithKey } from '@src/response/dsh/util';
import { resetGroupSession } from '@src/dsh/orchestrator';

export default async (): Promise<void> => {
  const [eventContext] = useEvent({ selects: ['message.create', 'private.message.create'] });

  if (!eventContext.match.selects) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();
  const reply = async (text: string, actions: { label: string; command: string }[] = []): Promise<unknown> =>
    await message.send({
      format: noticeBubble(text, { platform: event.Platform, title: '新会话', actions })
    });

  const channelId = getConversationId(event);

  if (!channelId) {
    await reply('无法识别当前会话。');

    return;
  }

  if (!event.IsPrivate && !(await canManageConversation(event))) {
    await reply('在群里开始新会话，需要管理员或机器人主人来操作。');

    return;
  }

  const sessionId = getSessionId(channelId);

  try {
    const config = getDSHConfig();

    if (event.IsPrivate && !(await canPrivateChatWithKey(event, config.privateChatAccess))) {
      await reply('仅机器人主人可在私聊中使用 Agent。');

      return;
    }
    await resetGroupSession(channelId, config);
    await reply(
      commandExpression(
        config,
        { platform: event.Platform, channelId },
        event.IsPrivate ? '好，我们换个话题聊。长期记忆和聊天记录都还在。' : '好，群里接下来从新话题聊起。长期记忆和聊天记录都还在。',
        event.IsPrivate ? '已开始新话题，长期记忆和聊天记录保留。' : '本群已开始新话题，长期记忆和聊天记录保留。'
      ),
      [
        { label: '帮助', command: '/帮助 聊天' },
        { label: '查看额度', command: '/额度' }
      ]
    );
  } catch (error) {
    logger.error({ err: error, sessionId }, 'DSH session clear failed');
    await reply(toUserMessage(error));
  }
};
