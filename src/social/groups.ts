import { classifyGroupReply } from './reply-gate';
import { logger } from 'alemonjs';
import { getDSHConfig, type AgentCapabilities } from '../dsh/client';
import { GroupConversationCoordinator } from './group-conversation';
import { boundKeyGroupPolicy, getGroupChatPolicy } from './group-policy';
import { getBoundCredential } from '../credentials/scoped';
import { withBudgetScope } from '../billing/budget';
import { moodGroupPolicy } from '../companion/expression';

export const scopedGroupPolicy = (channelId: string, platform = '') => {
  const config = getDSHConfig();

  return moodGroupPolicy(config, { channelId, platform }, getGroupChatPolicy(config.groupChat, channelId));
};

/**
 * 自带 Key 的群同时开放网页与文件工具；终端不在提权范围内，始终为 false。
 * 不想让某个群走提权时，在 groupChat.overrides 里给该群设 boundKeyElevation: false。
 */
export const isKeyEntitledGroup = async (scope: { platform?: string; channelId: string; userId?: string }): Promise<boolean> => {
  if (!scope.platform) return false;
  if (getGroupChatPolicy(getDSHConfig().groupChat, scope.channelId).boundKeyElevation === false) return false;
  try {
    const bound = await withBudgetScope({ platform: scope.platform, channelId: scope.channelId, userId: scope.userId }, getBoundCredential);

    return Boolean(bound);
  } catch {
    return false;
  }
};

/** 自带 Key 的群是否放开网页与文件工具；终端永远为 false。 */
export const entitledCapabilities = (capabilities: AgentCapabilities, entitled: boolean, allowTools: boolean): AgentCapabilities =>
  entitled && allowTools ? { ...capabilities, web: true, files: true, terminal: false } : capabilities;

export const resolveGroupCapabilities = async (
  scope: { platform?: string; channelId: string; userId?: string; private?: boolean },
  capabilities: AgentCapabilities
): Promise<AgentCapabilities> => {
  if (scope.private || (capabilities.web && capabilities.files)) return capabilities;
  const allowTools = getGroupChatPolicy(getDSHConfig().groupChat, scope.channelId).boundKeyTools !== false;

  return entitledCapabilities(capabilities, await isKeyEntitledGroup(scope), allowTools);
};

const processState = globalThis as typeof globalThis & { __agentLinkGroupConversations__?: GroupConversationCoordinator };

export const groupConversations = (processState.__agentLinkGroupConversations__ ??= new GroupConversationCoordinator({
  classify: classifyGroupReply,
  resolvePolicy: async (message, policy) => {
    if (!message.platform) return policy;
    try {
      const bound = await withBudgetScope({ platform: message.platform, channelId: message.channelId, userId: message.userId }, getBoundCredential);

      return bound ? boundKeyGroupPolicy(policy) : policy;
    } catch {
      return policy;
    }
  },
  getPolicy: scopedGroupPolicy,
  onTiming: timing => logger.info(timing, 'Group reply latency'),
  onError: () => logger.warn('AgentLink group conversation failed')
}));
