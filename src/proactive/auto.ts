import type { DSHBridgeConfig } from '../dsh/config';
import { proactiveEnabled, proactiveOptions } from './options';
import { getProactiveStore } from './store';

type OwnerEvent = {
  IsPrivate?: boolean;
  IsMaster?: boolean;
  Platform?: string;
  BotId?: string;
  UserId?: string;
};

/**
 * 主动搭话默认对主人私聊生效：只补建不存在的订阅。
 * 主人用 /主动搭话 关闭 后，已有 row 会阻止这里重新开启。
 */
export const ensureProactiveSubscription = (config: DSHBridgeConfig, event: OwnerEvent): void => {
  if (!event.IsPrivate || !event.IsMaster || !event.Platform || !event.BotId || !event.UserId || !proactiveEnabled(config)) return;
  const options = proactiveOptions(config);

  if (!options.autoSubscribe) return;
  const scope = { platform: event.Platform, botId: event.BotId, userId: event.UserId };
  const store = getProactiveStore(config);

  if (store.get(scope)) return;
  store.subscribe(scope, true, options);
};
