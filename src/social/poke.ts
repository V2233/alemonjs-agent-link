import type { DSHBridgeConfig } from '../dsh/client';
import { getConversationId } from '../response/dsh/util';
import { getPlatformLedger } from '../platform/ledger';
import type { ChatEvent } from '../response/dsh/chat';

export type PokeEvent = ChatEvent & {
  EventId?: string;
  OccurredAt?: number;
  Poke?: { actorId: string; targetId: string };
  _Poke?: { actorId: string; targetId: string };
};
export const claimPoke = (config: DSHBridgeConfig, event: PokeEvent): boolean => {
  const poke = event.Poke || event._Poke;
  const channelId = getConversationId(event);

  if (
    config.modules?.disabled?.includes('platform') ||
    event.Platform !== 'onebot' ||
    !event.BotId ||
    !channelId ||
    !event.EventId ||
    poke?.targetId !== event.BotId ||
    poke.actorId !== event.UserId ||
    poke.actorId === event.BotId ||
    event.IsBot ||
    !Number.isFinite(event.OccurredAt) ||
    Math.abs(Date.now() - event.OccurredAt) > 60000
  ) {
    return false;
  }

  return getPlatformLedger(config).claimCooldown(JSON.stringify([event.Platform, event.BotId, channelId, 'poke-inbound']), 20, channelId);
};
