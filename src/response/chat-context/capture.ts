import { describeSpeaker, extractWakePrompt } from '@src/response/dsh/util';
import { logger, useEvent, useMention } from 'alemonjs';
import { getDSHConfig } from '@src/dsh/client';
import { recordRecentMessage } from '@src/chat-context/store';

export default async (): Promise<void> => {
  const [eventContext, next] = useEvent({ selects: 'message.create' });

  if (!eventContext.match.selects) {
    return;
  }

  const event = eventContext.current;
  const text = String(event.MessageText ?? '').trim();

  if (event.IsBot || !event.ChannelId || !text || text.startsWith('/')) {
    await Promise.resolve(next());

    return;
  }

  const [mention] = useMention();
  const mentionedBot = await mention.findOne({ IsBot: true });

  if (!mentionedBot.data) {
    try {
      const config = getDSHConfig();

      if (extractWakePrompt(text, config.groupWakeNames) === null) {
        await recordRecentMessage(
          event.ChannelId,
          {
            id: event.MessageId,
            text: `${describeSpeaker(event)}: ${text}`
          },
          {
            maxMessages: config.recentChatMaxMessages,
            windowSeconds: config.recentChatWindowSeconds,
            maxChars: config.recentChatMaxChars
          },
          config
        );
      }
    } catch (error) {
      logger.warn({ err: error }, 'Recent chat context disabled by invalid configuration');
    }
  }

  await Promise.resolve(next());
};
