import type { DSHBridgeConfig } from './config';

/** Queue identity is separate from the raw channel used by platform APIs and tools. */
export type ConversationQueueScope = { namespace: string; platform: string; botId: string };
export const conversationQueueScope = (
  config: Pick<DSHBridgeConfig, 'workspaceRoot' | 'dshHomeRoot'>,
  identity: { platform?: string; botId?: string }
): ConversationQueueScope => ({
  namespace: JSON.stringify([config.workspaceRoot, config.dshHomeRoot]),
  platform: identity.platform || '',
  botId: identity.botId || ''
});
export const conversationQueueKey = (channelId: string, scope?: ConversationQueueScope): string =>
  JSON.stringify([scope?.namespace || '', scope?.platform || '', scope?.botId || '', channelId]);
