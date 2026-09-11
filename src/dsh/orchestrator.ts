import { logger } from 'alemonjs';
import { clearSession, DSHError, getDSHConfig, streamChat, type DSHBridgeConfig, type DSHStreamEvent } from '@src/dsh/client';
import { SessionRegistry } from '@src/state/registry';

type Job = { userId: string; run: () => Promise<void>; reject: (error: Error) => void };
type GroupQueue = { running: boolean; jobs: Job[]; cancel?: AbortController; activeUserId?: string };
const queues = new Map<string, GroupQueue>();
const isolationTransitions = new Map<string, Promise<void>>();
let activeRequests = 0;

const acquireRequestSlot = (limit: number): (() => void) => {
  if (activeRequests >= limit) {
    throw new DSHError('http', 'Agent 服务繁忙，请稍后重试');
  }

  activeRequests += 1;
  let released = false;

  return () => {
    if (!released) {
      released = true;
      activeRequests -= 1;
    }
  };
};

export const getRequestCapacity = (): { active: number } => ({ active: activeRequests });

const enqueue = async (
  channelId: string,
  maxQueued: number,
  userId: string,
  run: (signal: AbortSignal) => Promise<void>,
  onQueued?: (ahead: number) => Promise<void>,
  onStarted?: (wasQueued: boolean) => Promise<void>
): Promise<void> => {
  const queue = queues.get(channelId) ?? { running: false, jobs: [] };

  queues.set(channelId, queue);
  if (queue.jobs.length >= maxQueued) {
    throw new DSHError('http', '当前群请求排队已满');
  }

  return await new Promise<void>((resolve, reject) => {
    const ahead = (queue.running ? 1 : 0) + queue.jobs.length;
    const queuedNotice = ahead > 0 && onQueued
      ? onQueued(ahead).catch(error => logger.warn({ err: error }, 'Unable to send DSH queue notice'))
      : Promise.resolve();

    queue.jobs.push({
      userId,
      reject,
      run: async () => {
        const controller = new AbortController();

        queue.cancel = controller;
        queue.activeUserId = userId;
        try {
          await queuedNotice;
          if (onStarted) {
            try {
              await onStarted(ahead > 0);
            } catch (error) {
              logger.warn({ err: error }, 'Unable to send DSH start notice');
            }
          }
          await run(controller.signal);
          resolve();
        } finally {
          queue.cancel = undefined;
          queue.activeUserId = undefined;
        }
      }
    });
    if (queue.running) {
      return;
    }
    queue.running = true;
    void (async () => {
      while (queue.jobs.length) {
        const next = queue.jobs.shift();

        try {
          await next.run();
        } catch (error) {
          next.reject(error instanceof Error ? error : new Error('queue failure'));
        }
      }
      queue.running = false;
      if (!queue.jobs.length) {
        queues.delete(channelId);
      }
    })();
  });
};

export const cancelGroupChat = (channelId: string): void => {
  const queue = queues.get(channelId);

  queue?.cancel?.abort();
  while (queue?.jobs.length) {
    queue.jobs.shift().reject(new DSHError('timeout', '群会话已重置'));
  }
};

/**
 * A missing isolation marker is not a user action item. Atomically perform
 * the same destructive boundary as /new before the first post-upgrade turn.
 */
export const ensureIsolatedGroup = async (channelId: string, config: DSHBridgeConfig): Promise<void> => {
  const registry = new SessionRegistry(config);

  await registry.ready();
  if ((await registry.meta(channelId)).isolated) {
    return;
  }

  const pending = isolationTransitions.get(channelId);

  if (pending !== undefined) {
    await pending;

    return;
  }

  const transition = (async (): Promise<void> => {
    cancelGroupChat(channelId);
    await clearSession(config, `dsh:qq:group:${channelId}`);
    await registry.advance(channelId);
    await registry.clearRecent(channelId);
    logger.info({ group: await registry.groupKey(channelId) }, 'Initialized isolated group session');
  })();

  isolationTransitions.set(channelId, transition);
  try {
    await transition;
  } finally {
    isolationTransitions.delete(channelId);
  }
};

export type CancelChatResult = 'cancelled-running' | 'cancelled-queued' | 'empty' | 'forbidden';

export const cancelChatForUser = (channelId: string, userId: string, privileged: boolean): CancelChatResult => {
  const queue = queues.get(channelId);

  if (!queue) {
    return 'empty';
  }

  if (queue.cancel && queue.activeUserId === userId) {
    queue.cancel.abort();

    return 'cancelled-running';
  }

  for (let index = queue.jobs.length - 1; index >= 0; index -= 1) {
    if (queue.jobs[index].userId === userId) {
      const [job] = queue.jobs.splice(index, 1);

      job.reject(new DSHError('cancelled', '群会话已取消'));

      return 'cancelled-queued';
    }
  }

  if (privileged && queue.cancel) {
    queue.cancel.abort();

    return 'cancelled-running';
  }

  return queue.running || queue.jobs.length ? 'forbidden' : 'empty';
};

export const runCoordinatedChat = async (
  event: { ChannelId: string; MessageId?: string; UserKey?: string },
  message: string,
  onEvent: (event: DSHStreamEvent) => Promise<void>,
  onQueued?: (ahead: number) => Promise<void>,
  onStarted?: (wasQueued: boolean) => Promise<void>
): Promise<{ requestId: string; duplicate: boolean }> => {
  const config = getDSHConfig();
  const registry = new SessionRegistry(config);

  await registry.ready();
  await ensureIsolatedGroup(event.ChannelId, config);
  const duplicate = await registry.deduplicate(event.ChannelId, event.MessageId);

  if (duplicate.duplicate) {
    return duplicate;
  }
  if (!(await registry.allowUser(event.ChannelId, event.UserKey || 'unknown'))) {
    throw new DSHError('http', '请求过于频繁');
  }
  const meta = await registry.touch(event.ChannelId);

  await enqueue(event.ChannelId, config.maxQueuedPerGroup, event.UserKey || 'unknown', async signal => {
    const release = acquireRequestSlot(config.maxConcurrentRequests);

    try {
      const current = await registry.meta(event.ChannelId);

      if (current.generation !== meta.generation) {
        throw new DSHError('timeout', '群会话已重置');
      }
      await streamChat(config, `dsh:qq:group:${event.ChannelId}:v${meta.generation}`, message, onEvent, event.UserKey, signal);
      await registry.touch(event.ChannelId);
    } finally {
      release();
    }
  }, onQueued, onStarted);
  logger.info({ requestId: duplicate.requestId, group: await registry.groupKey(event.ChannelId), status: 'completed' }, 'DSH chat completed');

  return duplicate;
};
