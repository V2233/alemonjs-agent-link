import { logger } from 'alemonjs';
import type { DSHBridgeConfig } from '../dsh/config';
import type { ChatEvent } from '../response/dsh/chat';
import { getProactiveStore } from './store';
import { proactiveOptions } from './options';

const scope = (event: ChatEvent) =>
  event.IsPrivate && event.IsMaster && !event.IsBot && event.Platform && event.BotId && event.UserId
    ? { platform: event.Platform, botId: event.BotId, userId: event.UserId }
    : undefined;

export const observeProactiveInput = (config: DSHBridgeConfig, event: ChatEvent): void => {
  const recipient = scope(event);

  if (!recipient || !event.MessageId) {
    return;
  }
  try {
    const store = getProactiveStore(config);

    if (!store.input(recipient, event.MessageId)) {
      return;
    }
    if (
      /^(?:请|先|以后|最近|你|麻烦你|拜托你){0,3}(?:别|不要|不用)(?:再)?主动(?:来)?(?:找|联系|打扰)我(?:了)?[。！!\s]*$/u.test(
        String(event.MessageText || '').trim()
      )
    ) {
      store.subscribe(recipient, false, proactiveOptions(config));
    }
  } catch {
    logger.warn('Proactive activity observation failed');
  }
};
export const observeProactiveOutput = (config: DSHBridgeConfig, event: ChatEvent, text: string): void => {
  const recipient = scope(event);

  if (!recipient || !event.MessageId) {
    return;
  }
  try {
    getProactiveStore(config).output(recipient, event.MessageId, text);
  } catch {
    logger.warn('Proactive reply observation failed');
  }
};
