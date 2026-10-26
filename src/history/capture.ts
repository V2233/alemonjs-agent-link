import { logger } from 'alemonjs';
import { randomUUID } from 'node:crypto';
import type { DSHBridgeConfig } from '../dsh/client';
import { canPrivateChat, getConversationId } from '../response/dsh/util';
import { getChatArchive, historyEnabled } from './store';
import { getMemoryStore } from '../memory/store';
import { memoryEnabled } from '../memory/consolidation';

type Event = {
  Platform?: string;
  ChannelId?: string;
  UserId?: string;
  UserName?: string;
  MessageId?: string;
  MessageText?: string;
  IsPrivate?: boolean;
  IsMaster?: boolean;
  IsBot?: boolean;
  MessageMedia?: { Type: string }[];
};
export const archiveIncoming = (config: DSHBridgeConfig, event: Event): void => {
  if (!historyEnabled(config) || event.IsBot || !event.Platform || !event.MessageId || (event.IsPrivate && !canPrivateChat(event, config.privateChatAccess))) {
    return;
  }
  const channelId = getConversationId(event);

  if (!channelId) {
    return;
  }
  // Authentication commands are operational secrets, not conversation history.
  if (/^\/(?:我的主人|我是主人|agentbind)(?:\s|$)/iu.test((event.MessageText || '').trimStart())) {
    return;
  }
  const text = [event.MessageText || '', ...(event.MessageMedia || []).map(item => `[附件:${item.Type}]`)].filter(Boolean).join('\n');

  try {
    getChatArchive(config).append(
      { platform: event.Platform, channelId },
      {
        id: event.MessageId,
        role: 'user',
        speakerId: event.UserId || '',
        speaker: event.UserName || event.UserId || '未知用户',
        text
      }
    );
  } catch {
    logger.error('聊天历史归档写入失败；当前消息未保存，请检查磁盘和权限。');

    return;
  }
  if (memoryEnabled(config)) {
    try {
      getMemoryStore(config).observe({ platform: event.Platform, channelId });
    } catch {
      logger.error('聊天记录已归档，但记忆整理范围登记失败。');
    }
  }
};
export const archiveReply = (config: DSHBridgeConfig, event: Event, text: string): void => {
  if (!historyEnabled(config) || !event.Platform) {
    return;
  }
  const channelId = getConversationId(event);

  if (!channelId) {
    return;
  }
  try {
    getChatArchive(config).append(
      { platform: event.Platform, channelId },
      {
        id: randomUUID(),
        role: 'assistant',
        speakerId: 'assistant',
        speaker: '大肥鱼',
        text
      }
    );
  } catch {
    logger.error('聊天历史归档写入失败；本次已发送回复未保存，请检查磁盘和权限。');
  }
};
