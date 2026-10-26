import { logger, useEvent } from 'alemonjs';
import { contextEvents, eventContexts, normalizeContextEvent } from '../../social/event-context';
import { messageReferences } from '../../social/references';
import { groupConversations } from '../../social/groups';
import { cancelGroupChat } from '../../dsh/orchestrator';
import { getConversationId } from '../dsh/util';
import { getDSHConfig } from '../../dsh/client';
import { SessionRegistry } from '../../state/registry';

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
    if (['message.update', 'message.delete', 'private.message.update', 'private.message.delete'].includes(event.name)) {
      const channelId = getConversationId(event);

      // Conservative cancellation: edits/withdrawals may affect another queued question's quote.
      if (channelId) {
        groupConversations.invalidateRecent(channelId);
        cancelGroupChat(channelId, false);
      }
      await messageReferences.invalidate(event);
      if (channelId) {
        await new SessionRegistry(getDSHConfig()).clearRecent(channelId).catch(() => logger.warn('Event recent-context cleanup failed'));
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
