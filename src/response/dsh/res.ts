import { Format, logger, useEvent, useMention, useMessage, useMedia } from 'alemonjs';
import { getDSHConfig, toUserMessage } from '@src/dsh/client';
import { extractPrompt, extractWakePrompt } from '@src/response/dsh/util';
import { groupConversations } from '../../social/groups';
import { respondToGroupBatch } from '../../social/respond';
import { getGroupChatPolicy } from '../../social/group-policy';
import { messageReferences } from '../../social/references';

export default async (): Promise<void> => {
  const [eventContext, next] = useEvent({ selects: 'message.create' });

  if (!eventContext.match.selects) {
    return;
  }

  const event = eventContext.current;
  const [message] = useMessage();

  if (event.IsBot || event.IsPrivate) {
    await Promise.resolve(next());

    return;
  }
  const [mention] = useMention();
  const mentionedBot = await mention.findOne({ IsBot: true });
  const references = await messageReferences.capture(event).catch(() => {
    logger.warn('Message reference capture failed');

    return { quote: undefined, missingQuote: event.ReplyId, forwarded: '' };
  });
  const referenceContext = JSON.stringify({
    quote: references.quote ? { sender: references.quote.userName || references.quote.userId, text: references.quote.text } : undefined,
    unavailableQuote: references.missingQuote ? '引用消息内容不可用，不能猜测原文。' : undefined,
    forwarded: references.forwarded || undefined
  });

  let prompt: string | null;

  try {
    prompt = mentionedBot.data
      ? extractPrompt(String(event.MessageText ?? ''), mentionedBot.data)
      : event.IsAtMe
        ? String(event.MessageText || '')
        : extractWakePrompt(event.MessageText, getDSHConfig().groupWakeNames);
    if (prompt === null && references.quote?.isBot) {
      prompt = event.MessageText || '用户引用了你的消息，请结合原文回应。';
    }
  } catch (error) {
    await message.send({ format: Format.create().addText(toUserMessage(error)) });

    return;
  }
  if (prompt !== null && !prompt && !event.MessageMedia?.length && !references.forwarded) {
    prompt = '用户 @ 了你，没有附带文字。';
  }

  const reply = async (text: string): Promise<unknown> =>
    await message.send({
      format: Format.create().addMarkdownOriginal(text)
    });

  if (prompt === '/new') {
    await reply('请直接发送 /new 开始新的群会话。');

    return;
  }

  const text = String(event.MessageText || '').trim();

  if (!event.ChannelId || (!text && !event.MessageMedia?.length && !references.forwarded) || text.startsWith('/')) {
    await Promise.resolve(next());

    return;
  }
  const [media] = useMedia();

  try {
    const decision = await groupConversations.receive(
      {
        channelId: event.ChannelId,
        id: event.MessageId,
        userId: event.UserId,
        userKey: event.UserKey || event.UserId,
        name: (event.UserName || '').slice(0, 80),
        owner: Boolean(event.IsMaster),
        text: text || prompt || '',
        direct: prompt !== null,
        media: event.MessageMedia,
        referenceContext: referenceContext === '{}' ? undefined : referenceContext
      },
      getGroupChatPolicy(getDSHConfig().groupChat, event.ChannelId),
      batch => respondToGroupBatch(event, { message, media }, batch)
    );

    if (decision.mode === 'none') {
      await Promise.resolve(next());
    }
  } catch (error) {
    logger.warn({ err: error }, 'Group conversation scheduling failed');
    if (prompt !== null) {
      await reply('群聊消息暂时无法处理，请稍后重试。');
    } else {
      await Promise.resolve(next());
    }
  }
};
