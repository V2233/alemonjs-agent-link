import { messageReferences } from '../../social/references';
import { logger, useEvent } from 'alemonjs';
import { getDSHConfig } from '../../dsh/client';
import { archiveIncoming } from '../../history/capture';

export default async (): Promise<void> => {
  const [context, next] = useEvent({ selects: ['message.create', 'private.message.create'] });

  try {
    if (context.match.selects) {
      await messageReferences.capture(context.current).catch(() => logger.warn('Message reference capture failed'));
      archiveIncoming(getDSHConfig(), context.current);
    }
  } catch {
    logger.error('聊天历史采集失败，请检查归档配置。');
  }
  await Promise.resolve(next());
};
