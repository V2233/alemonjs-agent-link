import { createHash } from 'node:crypto';
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

export const sessionBaseId = (channelId: string): string =>
  channelId.startsWith('private:') ? `dsh:qq:private:${channelId.slice('private:'.length)}` : `dsh:qq:group:${channelId}`;
export const bridgeSessionHash = (sessionBase: string): string => createHash('sha256').update(sessionBase).digest('hex');
export type BridgeConversationIdentity = { groupKey: string; scopeKey: string };
export const bridgeConversationIdentity = (channelId: string, scope: ConversationQueueScope): BridgeConversationIdentity => ({
  groupKey: bridgeSessionHash(sessionBaseId(channelId)),
  scopeKey: createHash('sha256').update(conversationQueueKey(channelId, scope)).digest('hex')
});

export type ConversationDataScope = { platform: string; channelId: string; botId?: string };
export const conversationDataNamespace = (config: Pick<DSHBridgeConfig, 'workspaceRoot' | 'dshHomeRoot'>): string =>
  createHash('sha256')
    .update(JSON.stringify([config.workspaceRoot, config.dshHomeRoot]))
    .digest('hex');
export const conversationDataKey = (scope: ConversationDataScope, namespace?: string): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        namespace !== undefined || scope.botId !== undefined
          ? ['v2', namespace ?? '', scope.platform, scope.botId ?? '', scope.channelId]
          : [scope.platform, scope.channelId]
      )
    )
    .digest('hex');
