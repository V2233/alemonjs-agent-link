import { RequestSlotPool } from './request-slots';
import { serializeByKey } from './serialize';
import { withBudgetScope } from '../billing/budget';
import type { ChatInput } from './input';
import { buildMemoryContext } from './memory';
import { logger } from 'alemonjs';
import { clearSession, DSHError, getDSHConfig, purgeSessionData, type DSHBridgeConfig, type DSHStreamEvent } from '@src/dsh/client';
import { runModuleTurn } from '../agent/turn';
import { groupConversations, resolveGroupCapabilities } from '../social/groups';
import { messageReferences } from '../social/references';
import { SessionRegistry } from '@src/state/registry';
import { getSessionId } from '@src/response/dsh/util';
import type { GroupPolicy } from '@src/state/registry';

type Job = { userId: string; run: () => Promise<void>; reject: (error: Error) => void };
type GroupQueue = { running: boolean; jobs: Job[]; cancel?: AbortController; activeUserId?: string };
const queues = new Map<string, GroupQueue>();
const groupResetTransitions = new Map<string, Promise<void>>();
const requestSlots = new RequestSlotPool();

export const getRequestCapacity = (): { active: number } => ({ active: requestSlots.active });
export const conversationBusy = (channelId: string): boolean => Boolean(queues.get(channelId)?.running || queues.get(channelId)?.jobs.length);

export const enqueueChat = async (
  channelId: string,
  maxQueued: number,
  userId: string,
  run: (signal: AbortSignal) => Promise<void>,
  onQueued?: (ahead: number) => Promise<void>,
  onStarted?: (wasQueued: boolean, signal: AbortSignal) => Promise<void>
): Promise<void> => {
  const queue = queues.get(channelId) ?? { running: false, jobs: [] };

  queues.set(channelId, queue);
  if (queue.running && queue.jobs.length >= maxQueued) {
    throw new DSHError('http', '当前群请求排队已满');
  }

  return await new Promise<void>((resolve, reject) => {
    const ahead = (queue.running ? 1 : 0) + queue.jobs.length;
    const queuedNotice =
      ahead > 0 && onQueued ? onQueued(ahead).catch(error => logger.warn({ err: error }, 'Unable to send DSH queue notice')) : Promise.resolve();

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
              await onStarted(ahead > 0, controller.signal);
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

export const cancelGroupChat = (channelId: string, clearPending = true): void => {
  if (clearPending) {
    groupConversations.clear(channelId);
    void messageReferences.clear(channelId).catch(() => logger.warn('Message reference cleanup failed'));
  }
  const queue = queues.get(channelId);

  queue?.cancel?.abort();
  while (queue?.jobs.length) {
    queue.jobs.shift().reject(new DSHError('cancelled', '会话已重置'));
  }
};

/**
 * A missing isolation marker is not a user action item. Atomically perform
 * the same destructive boundary as /new before the first post-upgrade turn.
 */
export const resetGroupSession = async (channelId: string, config: DSHBridgeConfig, updateMemory?: () => Promise<void>, clearPending = true): Promise<void> => {
  const pending = groupResetTransitions.get(channelId);

  if (pending !== undefined) {
    await pending;
    if (updateMemory) {
      await resetGroupSession(channelId, config, updateMemory, clearPending);
    }

    return;
  }
  const registry = new SessionRegistry(config);
  const transition = (async (): Promise<void> => {
    await registry.ready();
    const resetting = await registry.beginReset(channelId);

    if (!resetting.operationId) {
      throw new DSHError('migration', '会话重置状态无效');
    }
    cancelGroupChat(channelId, clearPending);
    await clearSession(config, getSessionId(channelId));
    await updateMemory?.();
    await registry.clearRecent(channelId);
    await registry.clearPrivateHistory(channelId);
    if (!(await registry.completeReset(channelId, resetting.operationId))) {
      throw new DSHError('migration', '会话重置被其他操作接管');
    }
    logger.info({ group: await registry.groupKey(channelId) }, 'Reset isolated group session');
  })();

  groupResetTransitions.set(channelId, transition);
  try {
    await transition;
  } finally {
    groupResetTransitions.delete(channelId);
  }
};

/**
 * Serializes the check-then-reset boundary per channel. Concurrent turns used to
 * all pass the "not isolated yet" check before any of them registered a pending
 * transition, so a burst wiped the session several times over. Every wipe throws
 * away the append-only transcript that makes prefix caching pay off, so the group
 * paid full price to re-prefill its whole history instead of reusing it.
 */
const groupResetLocks = new Map<string, Promise<void>>();

const withGroupResetLock = <T>(channelId: string, work: () => Promise<T>): Promise<T> => serializeByKey(groupResetLocks, channelId, work);

/** Initialize old metadata behind the same serialized boundary as /new. */
export const ensureIsolatedGroup = async (channelId: string, config: DSHBridgeConfig): Promise<void> => {
  const pending = groupResetTransitions.get(channelId);

  if (pending !== undefined) {
    await pending;
  }

  await withGroupResetLock(channelId, async () => {
    const registry = new SessionRegistry(config);

    await registry.ready();
    const meta = await registry.meta(channelId);

    if (meta.isolated && !meta.transition) {
      return;
    }

    if (meta.transition === 'purging') {
      await purgeGroupSession(channelId, config);
    }

    await resetGroupSession(channelId, config, undefined, false);
  });
};

/** Mark deletion before touching the Bridge so a failed purge can be resumed safely. */
export const purgeGroupSession = async (channelId: string, config: DSHBridgeConfig): Promise<void> => {
  const pending = groupResetTransitions.get(channelId);

  if (pending !== undefined) {
    await pending;
  }
  const registry = new SessionRegistry(config);
  const transition = (async (): Promise<void> => {
    await registry.ready();
    await registry.beginPurge(channelId);
    cancelGroupChat(channelId);
    await purgeSessionData(config, `dsh:qq:group:${channelId}`);
    await registry.purgeHash(await registry.groupKey(channelId));
  })();

  groupResetTransitions.set(channelId, transition);
  try {
    await transition;
  } finally {
    if (groupResetTransitions.get(channelId) === transition) {
      groupResetTransitions.delete(channelId);
    }
  }
};

export type CancelChatResult = 'cancelled-running' | 'cancelled-queued' | 'empty' | 'forbidden';
export type CoordinatedChatResult = {
  requestId: string;
  duplicate: boolean;
  confirmDelivery: () => Promise<void>;
  release: () => Promise<void>;
};

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

const runCoordinatedChatInner = async (
  event: {
    ChannelId: string;
    MessageId?: string;
    UserKey?: string;
    UserId?: string;
    Platform?: string;
    BotId?: string;
    IsPrivate?: boolean;
    IsMaster?: boolean;
  },
  message: string,
  onEvent: (event: DSHStreamEvent) => Promise<void>,
  onQueued?: (ahead: number) => Promise<void>,
  onStarted?: (wasQueued: boolean, signal: AbortSignal) => Promise<void>,
  capabilityOverride?: GroupPolicy,
  onCompleted?: (signal: AbortSignal) => Promise<void>,
  mediaTask?: {
    streamContent?: boolean;
    onImage?: (png: Buffer) => Promise<void>;
    onSpeech?: import('../agent/types').TurnContext['onSpeech'];
    onSticker?: import('../agent/types').TurnContext['onSticker'];
    onStickerCollect?: import('../agent/types').TurnContext['onStickerCollect'];
    onCurrentImages?: import('../agent/types').TurnContext['onCurrentImages'];
    prepareMessage?: (text: string, signal: AbortSignal) => Promise<ChatInput>;
    execute?: (signal: AbortSignal) => Promise<void>;
    userText?: string;
    recordHistory?: () => boolean;
    inputId?: string;
    addressed?: boolean;
    autonomous?: boolean;
    signal?: AbortSignal;
    renderAnswer?: (text: string) => string;
  }
): Promise<CoordinatedChatResult> => {
  const config = getDSHConfig();
  const registry = new SessionRegistry(config);

  await registry.ready();
  await ensureIsolatedGroup(event.ChannelId, config);
  const resolvedCapabilities = capabilityOverride ?? (await registry.policy(event.ChannelId));
  const capabilities = await resolveGroupCapabilities(
    { platform: event.Platform, channelId: event.ChannelId, userId: event.UserId, private: event.IsPrivate },
    resolvedCapabilities
  );

  if (!capabilities.chat) {
    throw new DSHError('http', '当前群未开放 Agent 对话权限');
  }
  const duplicate = await registry.deduplicate(event.ChannelId, event.MessageId);

  if (duplicate.duplicate) {
    return { ...duplicate, confirmDelivery: () => Promise.resolve(), release: () => Promise.resolve() };
  }
  const release = async (): Promise<void> => await registry.releaseDeduplication(event.ChannelId, event.MessageId, duplicate.requestId);

  try {
    if (!(await registry.allowUser(event.ChannelId, event.UserKey || 'unknown'))) {
      throw new DSHError('http', '请求过于频繁');
    }
    const meta = await registry.touch(event.ChannelId);
    const queuedAt = Date.now();

    await enqueueChat(
      event.ChannelId,
      config.maxQueuedPerGroup,
      event.UserKey || 'unknown',
      async signal => {
        signal = mediaTask?.signal ? AbortSignal.any([signal, mediaTask.signal]) : signal;
        signal.throwIfAborted();
        const startedAt = Date.now();
        const queueWaitMs = startedAt - queuedAt;
        let firstContentMs: number | undefined;
        let releaseRequestSlot = requestSlots.acquire(config.maxConcurrentRequests);

        try {
          const current = await registry.meta(event.ChannelId);

          if (current.generation !== meta.generation || !current.isolated || current.transition) {
            throw new DSHError('cancelled', '会话已重置');
          }
          if (mediaTask?.execute) {
            await mediaTask.execute(signal);
          } else {
            const memoryContext = event.ChannelId.startsWith('private:') ? buildMemoryContext(await registry.privateMemories(event.ChannelId)) : '';

            signal.throwIfAborted();
            const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]);

            await runModuleTurn({
              config,
              sessionId: `${getSessionId(event.ChannelId)}:v${meta.generation}`,
              input: mediaTask?.prepareMessage ? await mediaTask.prepareMessage(message, signal) : message,
              onEvent: async modelEvent => {
                if (modelEvent.type === 'content' && modelEvent.content && firstContentMs === undefined) {
                  firstContentMs = Date.now() - startedAt;
                  logger.info({ requestId: duplicate.requestId, queueWaitMs, firstContentMs }, 'Agent first content');
                }
                await onEvent(modelEvent);
              },
              streamContent: mediaTask?.streamContent,
              onImage: mediaTask?.onImage,
              onSpeech: mediaTask?.onSpeech,
              onSticker: mediaTask?.onSticker,
              onStickerCollect: mediaTask?.onStickerCollect,
              onCurrentImages: mediaTask?.onCurrentImages,
              context: {
                requestId: duplicate.requestId,
                inputId: mediaTask?.inputId || event.MessageId || duplicate.requestId,
                addressed: mediaTask?.addressed,
                autonomous: mediaTask?.autonomous,
                channelId: event.ChannelId,
                userId: event.UserId || event.UserKey || 'unknown',
                platform: event.Platform || '',
                botId: event.BotId,
                private: event.ChannelId.startsWith('private:'),
                owner: Boolean(event.IsMaster),
                userText: mediaTask?.userText ?? message,
                capabilities,
                signal: turnSignal,
                yieldForTools: async () => {
                  const release = releaseRequestSlot;

                  releaseRequestSlot = () => {};
                  releaseRequestSlot = await requestSlots.requeue(release, config.maxConcurrentRequests, turnSignal);
                }
              },
              history: {
                channelId: event.ChannelId,
                generation: meta.generation,
                memoryContext,
                record: mediaTask?.recordHistory,
                render: mediaTask?.renderAnswer
              },
              onCompleted
            });
          }
          signal.throwIfAborted();
          await registry.touch(event.ChannelId, meta.generation);
        } catch (error) {
          logger.warn(
            { requestId: duplicate.requestId, elapsedMs: Date.now() - startedAt, kind: error instanceof DSHError ? error.kind : 'unexpected' },
            'Agent turn failed'
          );
          if (signal.aborted) {
            throw new DSHError('cancelled', '请求已取消');
          }
          throw error;
        } finally {
          logger.info(
            { requestId: duplicate.requestId, queueWaitMs, firstContentMs: firstContentMs ?? null, elapsedMs: Date.now() - startedAt },
            'Agent turn latency'
          );
          releaseRequestSlot();
        }
      },
      onQueued,
      onStarted
    );
  } catch (error) {
    await release().catch(releaseError => logger.warn({ err: releaseError }, 'Unable to release failed DSH request'));
    throw error;
  }
  logger.info({ requestId: duplicate.requestId, group: await registry.groupKey(event.ChannelId), status: 'model_completed' }, 'DSH chat completed');

  return {
    ...duplicate,
    confirmDelivery: async (): Promise<void> => {
      const finalized = await registry.finalizeDeduplication(event.ChannelId, event.MessageId, duplicate.requestId);

      if (!finalized) {
        logger.warn(
          { requestId: duplicate.requestId, group: await registry.groupKey(event.ChannelId) },
          'DSH response delivery confirmation lost its request claim'
        );

        return;
      }
      logger.info({ requestId: duplicate.requestId, group: await registry.groupKey(event.ChannelId), status: 'delivered' }, 'DSH response delivered');
    },
    release
  };
};

export const runCoordinatedChat = (...args: Parameters<typeof runCoordinatedChatInner>): ReturnType<typeof runCoordinatedChatInner> =>
  withBudgetScope({ platform: args[0].Platform || '', channelId: args[0].ChannelId, userId: args[0].UserId }, () => runCoordinatedChatInner(...args));
