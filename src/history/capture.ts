import { isPersonalKeyCommand } from '../credentials/personal';
import { buildMessageContext, type MessageContextEvent } from '../social/message-context';
import { logger, type MessageReceipt, type MediaReceipt } from 'alemonjs';
import { randomUUID } from 'node:crypto';
import type { DSHBridgeConfig } from '../dsh/client';
import { canPrivateChat, getConversationId } from '../response/dsh/util';
import { getChatArchive, historyEnabled } from './store';
import { getMemoryStore } from '../memory/store';
import { memoryEnabled } from '../memory/consolidation';

type Event = MessageContextEvent & {
  Platform?: string;
  ChannelId?: string;
  UserId?: string;
  UserName?: string;
  MessageId?: string;
  MessageText?: string;
  IsPrivate?: boolean;
  IsMaster?: boolean;
  IsBot?: boolean;
};
export const archiveIncoming = (config: DSHBridgeConfig, event: Event): void => {
  if (isPersonalKeyCommand(event.MessageText)) return;
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
        text,
        referenceId: event.MessageContent?.referenceId,
        replyToId: event.MessageContent?.replyReferenceId || event.ReplyId,
        platformIdKnown: true,
        context: buildMessageContext(event, event.MessageMentions, event.IsPrivate ? 'private' : 'ambient')
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
export const archiveReply = (config: DSHBridgeConfig, event: Event, text: string, receipt?: MessageReceipt | MediaReceipt | null, replyToId?: string): void => {
  if (!historyEnabled(config) || !event.Platform) {
    return;
  }
  const channelId = getConversationId(event);

  if (!channelId) {
    return;
  }
  const platformId = receipt && ('id' in receipt ? receipt.id : 'messageId' in receipt ? receipt.messageId : undefined);
  const referenceId = receipt && 'referenceId' in receipt ? receipt.referenceId : undefined;

  try {
    getChatArchive(config).append(
      { platform: event.Platform, channelId },
      {
        id: platformId || `local:${randomUUID()}`,
        role: 'assistant',
        speakerId: event.BotId || 'assistant',
        speaker: '大肥鱼',
        text,
        referenceId,
        replyToId,
        sourceMessageId: event.MessageId,
        platformIdKnown: Boolean(platformId)
      }
    );
  } catch {
    logger.error('聊天历史归档写入失败；本次已发送回复未保存，请检查磁盘和权限。');
  }
};
