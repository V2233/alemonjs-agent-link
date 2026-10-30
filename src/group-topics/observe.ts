import type { DSHBridgeConfig } from '../dsh/config';
import { getGroupTopicStore, groupTopicId } from './store';

type TopicEvent = {
  IsPrivate?: boolean;
  IsBot?: boolean;
  Platform?: string;
  BotId?: string;
  ChannelId?: string;
  UserId?: string;
  MessageId?: string;
  MessageText?: string;
};
export const observeGroupTopics = (config: DSHBridgeConfig, event: TopicEvent): void => {
  if (
    config.aiEnabled === false ||
    event.IsPrivate ||
    event.IsBot ||
    !event.UserId ||
    event.UserId === event.BotId ||
    !event.Platform ||
    !event.BotId ||
    !event.ChannelId ||
    !event.MessageId
  )
    return;
  const text = event.MessageText?.trim();

  if (!text || text.startsWith('/') || text.length > 1500) return;
  getGroupTopicStore(config).observe(
    {
      id: groupTopicId(event.Platform, event.BotId, event.ChannelId),
      platform: event.Platform,
      botId: event.BotId,
      channelId: event.ChannelId,
      positioning: '正在从公开讨论学习群主题',
      tags: [],
      blockedTags: [],
      enabled: true,
      shareOut: true,
      receiveShared: true,
      manual: false
    },
    event.MessageId,
    text
  );
};
