import { getChatArchive, historyEnabled } from '../../history/store';
import { archiveIncoming } from '../../history/capture';
import { canPrivateChatWithKey } from '../dsh/util';
import { logger, useEvent } from 'alemonjs';
import { contextEvents, eventContexts, normalizeContextEvent } from '../../social/event-context';
import { messageReferences } from '../../social/references';
import { groupConversations } from '../../social/groups';
import { cancelGroupChat, conversationQueueScope } from '../../dsh/orchestrator';
import { getConversationId } from '../dsh/util';
import { getDSHConfig } from '../../dsh/client';
import { SessionRegistry } from '../../state/registry';
import { claimPoke } from '../../social/poke';
import { runDSHChat } from '../dsh/chat';
import { submitGroupChat } from '../../social/respond';
import { observeProactiveInput } from '../../proactive/observe';
import { useMedia, useMessage } from 'alemonjs';

export default async (): Promise<void> => {
  const [context, next] = useEvent({ selects: [...contextEvents] });

  try {
    if (!context.match.selects) {
      return;
    }
    const event = normalizeContextEvent(context.current);

    if (!eventContexts.record(event)) {
      return;
    }
    const config = getDSHConfig();

    if (['notice.create', 'private.notice.create'].includes(event.name) && claimPoke(config, event)) {
      observeProactiveInput(config, event);
      const transport = { message: useMessage()[0], media: useMedia()[0] };
      const prompt = '当前发言人刚刚戳了戳你。请自然地回应，可以适度使用 poke_speaker 回戳，不要每次都回戳。';

      if (event.IsPrivate) {
        await runDSHChat(event, prompt, { transport, userText: '[戳了戳你]' });
      } else {
        await submitGroupChat(event, prompt, transport);
      }
    }
    if (['message.update', 'message.delete', 'private.message.update', 'private.message.delete'].includes(event.name)) {
      const channelId = getConversationId(event);

      // Conservative cancellation: edits/withdrawals may affect another queued question's quote.
      if (channelId) {
        groupConversations.invalidateRecent(channelId, { platform: event.Platform, botId: event.BotId });
        cancelGroupChat(channelId, false, conversationQueueScope(config, { platform: event.Platform, botId: event.BotId }));
      }
      await messageReferences.invalidate(event);
      if (channelId && event.Platform && historyEnabled(config)) {
        const id = event.MessageContent?.referenceId || event.MessageId;

        if (id) getChatArchive(config).invalidate({ platform: event.Platform, channelId, botId: event.BotId || '' }, id);
        if (event.name.endsWith('.update')) archiveIncoming(config, event, event.IsPrivate && (await canPrivateChatWithKey(event, config.privateChatAccess)));
      }
      if (channelId) {
        await new SessionRegistry(config)
          .clearRecent(channelId, conversationQueueScope(config, { platform: event.Platform, botId: event.BotId }))
          .catch(() => logger.warn('Event recent-context cleanup failed'));
      }
      if (event.name.endsWith('.update') && typeof event.MessageText === 'string') {
        await messageReferences.capture(event);
      }
    }
  } catch {
    logger.warn('Platform event context processing failed');
  } finally {
    await Promise.resolve(next());
  }
};
