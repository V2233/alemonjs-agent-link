import { classifyGroupReply } from './reply-gate';
import { logger } from 'alemonjs';
import { getDSHConfig } from '../dsh/client';
import { GroupConversationCoordinator } from './group-conversation';
import { getGroupChatPolicy } from './group-policy';

const processState = globalThis as typeof globalThis & { __agentLinkGroupConversations__?: GroupConversationCoordinator };

export const groupConversations = (processState.__agentLinkGroupConversations__ ??= new GroupConversationCoordinator({
  classify: classifyGroupReply,
  getPolicy: channelId => getGroupChatPolicy(getDSHConfig().groupChat, channelId),
  onError: () => logger.warn('AgentLink group conversation failed')
}));
