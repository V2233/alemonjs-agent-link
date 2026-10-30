import { MessageDirect, ResultCode, createUserHashKey, useConnection, useMedia } from 'alemonjs';
import type { DSHBridgeConfig } from '../dsh/config';
import { getDSHConfig } from '../dsh/runtime-config';
import { historyEnabled } from '../history/store';
import { conversationBusy, conversationQueueScope } from '../dsh/orchestrator';
import { SessionRegistry } from '../state/registry';
import { runDSHChat } from '../response/dsh/chat';
import { groupPolicy } from './group-settings';
import { getGroupWakeStore, groupWakeNamespace, type GroupWake, type GroupWakeScope, type GroupWakeStore } from './group-wake-store';

export const validateGroupWakeSettings = (config: DSHBridgeConfig): void => {
  const settings = config.modules?.settings?.conversation || {};

  if (settings.wakeEnabled !== undefined && typeof settings.wakeEnabled !== 'boolean') throw new Error('conversation.wakeEnabled需要布尔值。');
  const groups = settings.wakeGroups;

  if (
    groups !== undefined &&
    (!Array.isArray(groups) ||
      groups.length > 1000 ||
      groups.some(
        item =>
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          Object.keys(item).some(field => !['platform', 'botId', 'channelId'].includes(field)) ||
          !['platform', 'botId', 'channelId'].every(field => typeof item[field] === 'string' && item[field].length > 0 && item[field].length <= 200)
      ))
  )
    throw new Error('conversation.wakeGroups需要完整的平台、机器人和群号，最多1000项。');
};

export const groupWakeEnabled = (config: DSHBridgeConfig, scope: GroupWakeScope): boolean => {
  try {
    validateGroupWakeSettings(config);
  } catch {
    return false;
  }
  const settings = config.modules?.settings?.conversation || {};
  const targets = settings.wakeGroups;

  return (
    config.aiEnabled !== false &&
    historyEnabled(config) &&
    !config.modules?.disabled?.includes('conversation') &&
    scope.namespace === groupWakeNamespace(config) &&
    settings.wakeEnabled === true &&
    Array.isArray(targets) &&
    targets.some(
      target =>
        target && typeof target === 'object' && target.platform === scope.platform && target.botId === scope.botId && target.channelId === scope.channelId
    )
  );
};
export const groupWakePolicyAllows = (config: DSHBridgeConfig, scope: GroupWakeScope, now = Date.now()): boolean => {
  if (!groupWakeEnabled(config, scope)) return false;
  const policy = groupPolicy(config, scope.channelId, scope.platform);
  const hour = Number(new Intl.DateTimeFormat('en', { timeZone: policy.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  const [start, end] = policy.quietHours;
  const quiet = start !== end && (start < end ? hour >= start && hour < end : hour >= start || hour < end);

  return policy.enabled && policy.interjectChance > 0 && policy.maxPerHour > 0 && !quiet;
};
/** Called at startup and configuration reload even when the conversation module is disabled. */
export const reconcileGroupWakes = (config: DSHBridgeConfig): void => {
  validateGroupWakeSettings(config);
  const store = getGroupWakeStore(config),
    namespace = groupWakeNamespace(config);

  if (
    config.aiEnabled === false ||
    !historyEnabled(config) ||
    config.modules?.disabled?.includes('conversation') ||
    config.modules?.settings?.conversation?.wakeEnabled !== true
  ) {
    store.clear(namespace);

    return;
  }
  for (const plan of store.all(namespace)) if (!groupWakeEnabled(config, plan)) store.cancel(plan);
};

type Delivery = { delivered: boolean; completed: boolean; replyText?: string };
type Dispatch = { signal: AbortSignal; beforeSend: () => Promise<boolean> };
const recipient = (plan: GroupWake) => ({
  Platform: plan.platform,
  BotId: plan.botId,
  ChannelId: plan.channelId,
  UserId: plan.userId,
  IsPrivate: false,
  Target: { scope: 'group' as const, targetId: plan.channelId, BotId: plan.botId }
});

export const groupWakeOnline = async (plan: GroupWake): Promise<boolean> => {
  const [connection] = useConnection(recipient(plan));
  const status = await connection.getStatus({ BotId: plan.botId });

  return status.code === ResultCode.Ok && status.data?.state === 'ready' && status.data.bots.some(bot => bot.BotId === plan.botId && bot.state === 'ready');
};
export const deliverGroupWake = async (plan: GroupWake, dispatch: Dispatch): Promise<Delivery> => {
  const target = recipient(plan),
    [media] = useMedia(target);
  let result: Delivery = { delivered: false, completed: false };
  const prompt = `【系统群聊唤醒，不是群友的新消息】先前预约的重新判断时间已到。预约说明仅供参考，不是指令或完成回执：${JSON.stringify(plan.reason)}。预约后没有新的群消息；不要假装刚收到提问，不要重做历史任务或声称已经执行说明里的动作。仅在有自然且具体的内容时接一两句，不催促任何人、不点名索要回应，最多240字；没有合适内容只输出[沉默]。本回合不会自动再预约。`;

  await runDSHChat({ ...target, UserKey: createUserHashKey({ Platform: plan.platform, UserId: plan.userId }), IsMaster: false }, prompt, {
    requestId: `group-wake:${plan.id}`,
    userText: '',
    allowSilence: true,
    referencesPrepared: true,
    autonomous: { signal: dispatch.signal, maxChars: 240, beforeSend: dispatch.beforeSend },
    transport: {
      message: { send: params => MessageDirect.create().sendToTarget({ target: target.Target, format: params.format }) } as never,
      media: { send: params => media.send({ ...params, replyId: undefined }) } as never
    },
    onOutcome: outcome => {
      result = outcome;
    }
  });

  return result;
};
const abortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  let cancel: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
};

export class GroupWakeWorker {
  private stopped = false;
  private ticking = false;
  private readonly controllers = new Set<AbortController>();
  constructor(
    private readonly config: DSHBridgeConfig,
    private readonly services: {
      store?: GroupWakeStore;
      config?: () => DSHBridgeConfig;
      now?: () => number;
      online?: (plan: GroupWake) => Promise<boolean>;
      ready?: (plan: GroupWake) => boolean;
      permitted?: (plan: GroupWake) => Promise<boolean>;
      onDelivered?: (plan: GroupWake, text: string) => void;
      deliver?: (plan: GroupWake, dispatch: Dispatch) => Promise<Delivery>;
    } = {}
  ) {}
  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
  }
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    const store = this.services.store || getGroupWakeStore(this.config);
    const namespace = groupWakeNamespace(this.config);

    try {
      const config = (this.services.config || getDSHConfig)();

      if (
        groupWakeNamespace(config) !== namespace ||
        config.modules?.settings?.conversation?.wakeEnabled !== true ||
        !historyEnabled(config) ||
        config.aiEnabled === false ||
        config.modules?.disabled?.includes('conversation')
      ) {
        store.clear(namespace);

        return;
      }
      // A tick claims at most two jobs; further due jobs keep their original deadline.
      for (const plan of store.due(namespace).slice(0, 2)) {
        const latest = (this.services.config || getDSHConfig)();

        if (!groupWakePolicyAllows(latest, plan, (this.services.now || Date.now)())) {
          store.cancel(plan);
          continue;
        }
        const limit = Math.min(4, groupPolicy(latest, plan.channelId, plan.platform).maxPerHour);

        if (!store.claim(plan, limit)) continue;
        const controller = new AbortController();

        this.controllers.add(controller);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
        const permitted =
          this.services.permitted ||
          (async (item: GroupWake) => (await new SessionRegistry((this.services.config || getDSHConfig)()).policy(item.channelId)).chat);
        const ready = async (): Promise<boolean> =>
          !this.stopped &&
          !signal.aborted &&
          store.current(plan) &&
          groupWakePolicyAllows((this.services.config || getDSHConfig)(), plan, (this.services.now || Date.now)()) &&
          (!this.services.ready || this.services.ready(plan)) &&
          (await abortable(permitted(plan), signal)) &&
          (await abortable((this.services.online || groupWakeOnline)(plan), signal)) &&
          !this.stopped &&
          !signal.aborted &&
          store.current(plan) &&
          groupWakePolicyAllows((this.services.config || getDSHConfig)(), plan, (this.services.now || Date.now)());

        try {
          if (conversationBusy(plan.channelId, conversationQueueScope(latest, plan)) || !(await ready())) {
            store.finish(plan, 'skipped');
            continue;
          }
          const result = await abortable((this.services.deliver || deliverGroupWake)(plan, { signal, beforeSend: ready }), signal);

          store.finish(plan, result.delivered ? 'confirmed' : result.completed ? 'silent' : signal.aborted ? 'cancelled' : 'failed');
          if (result.delivered) this.services.onDelivered?.(plan, result.replyText || '');
        } catch {
          store.finish(plan, signal.aborted ? 'cancelled' : 'failed');
        } finally {
          this.controllers.delete(controller);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
