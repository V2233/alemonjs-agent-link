import { useMention, type MessageMediaItem, type ReceivedMessage, type ActionTarget } from 'alemonjs';
import { groupAdminStatus } from '../platform/member-role';

type Mention = { UserId: string; UserName?: string; IsBot?: boolean };
export type MessageContextEvent = {
  name?: string;
  Platform?: string;
  ChannelId?: string;
  GuildId?: string;
  UserId?: string;
  UserName?: string;
  Role?: string;
  IsAdmin?: boolean;
  IsBot?: boolean;
  MessageId?: string;
  EventId?: string;
  ReplyId?: string;
  OccurredAt?: number;
  CreateAt?: number;
  Target?: ActionTarget;
  MessageContent?: ReceivedMessage;
  MessageMedia?: MessageMediaItem[];
  MessageMentionEveryone?: boolean;
  PlatformAction?: {
    kind: string;
    actorId?: string;
    subjectId?: string;
    durationSeconds?: number;
    oldName?: string;
    newName?: string;
  };
  BotId?: string;
  IsAtMe?: boolean;
  IsPrivate?: boolean;
  MessageText?: string;
  MessageMentions?: Mention[];
};
export type MessageContext = {
  schemaVersion: 1;
  conversation: { platform: string | null; scope: string | null; channelId: string | null; guildId: string | null; botId: string | null };
  sender: { id: string | null; name: string | null; platformRole: string | null; isAdmin: boolean | null; isBot: boolean | null };
  message: { id: string | null; eventId: string | null; eventType: string | null; replyToId: string | null };
  time: { occurredAt: string | null; receivedAt: string | null };
  attachments: {
    index: number;
    type: string;
    name: string | null;
    mimeType: string | null;
    bytes: number | null;
    width: number | null;
    height: number | null;
    transcript: string | null;
    contentStatus: string;
  }[];
  attachmentsTruncated: boolean;
  mentionEveryone: boolean | null;
  platformAction: MessageContextEvent['PlatformAction'] | null;
  trigger: 'mention' | 'wake_name' | 'quote' | 'command' | 'private' | 'ambient' | 'platform_event';
  mentions: { id: string; name: string | null; isSelf: boolean | null; isBot: boolean | null }[];
  mentionsKnown: boolean;
  mentionsTruncated: boolean;
  mentionedSelf: boolean;
};

const label = (value: unknown, max = 200): string | null => (typeof value === 'string' && value ? value.slice(0, max) : null);
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const size = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

export const eventTime = (value: unknown): string | null => {
  const time = size(value);

  return time !== null && time <= 8640000000000000 ? new Date(time).toISOString() : null;
};
export const describePlatformAction = (action?: MessageContextEvent['PlatformAction']): MessageContext['platformAction'] => {
  if (
    !action ||
    !['poke', 'recall', 'member_join', 'member_leave', 'member_kick', 'ban', 'unban', 'admin_set', 'admin_unset', 'card_change'].includes(action.kind)
  ) {
    return null;
  }

  return {
    kind: action.kind,
    actorId: label(action.actorId) ?? undefined,
    subjectId: label(action.subjectId) ?? undefined,
    durationSeconds: size(action.durationSeconds) ?? undefined,
    oldName: label(action.oldName, 80) ?? undefined,
    newName: label(action.newName, 80) ?? undefined
  };
};

// Only normalized mention identities are exposed; never serialize the raw platform event.
export const buildMessageContext = (event: MessageContextEvent, mentions: Mention[] | undefined, trigger: MessageContext['trigger']): MessageContext => {
  const unique = [...new Map((mentions || []).filter(item => typeof item.UserId === 'string' && item.UserId).map(item => [item.UserId, item])).values()];

  return {
    schemaVersion: 1,
    conversation: {
      platform: label(event.Platform),
      scope: event.IsPrivate ? 'private' : label(event.Target?.scope) || (event.ChannelId ? 'group_or_channel' : null),
      channelId: label(event.ChannelId),
      guildId: label(event.GuildId),
      botId: label(event.BotId)
    },
    sender: {
      id: label(event.UserId),
      name: label(event.UserName, 80),
      platformRole: label(event.Role, 40),
      isAdmin: groupAdminStatus(event),
      isBot: flag(event.IsBot)
    },
    message: {
      id: label(event.MessageId),
      eventId: label(event.EventId),
      eventType: label(event.name),
      replyToId: label(event.MessageContent?.replyReferenceId || event.ReplyId)
    },
    time: { occurredAt: eventTime(event.OccurredAt), receivedAt: eventTime(event.CreateAt) },
    attachments: (event.MessageMedia || []).slice(0, 10).map((item, index) => ({
      index: index + 1,
      type: item.Type,
      name: label(item.FileName),
      mimeType: label(item.MimeType, 80),
      bytes: size(item.FileSize),
      width: size(item.Width),
      height: size(item.Height),
      transcript: label(item.Transcript, 200),
      contentStatus: item.Transcript ? 'platform_transcript_available' : 'metadata_only_content_not_yet_read'
    })),
    attachmentsTruncated: (event.MessageMedia?.length || 0) > 10,
    mentionEveryone: flag(event.MessageMentionEveryone),
    platformAction: describePlatformAction(event.PlatformAction),
    trigger,
    mentionsKnown: Array.isArray(mentions),
    mentionsTruncated: unique.length > 20,
    mentionedSelf: Boolean(event.IsAtMe || (event.BotId && unique.some(item => item.UserId === event.BotId))),
    mentions: unique.slice(0, 20).map(item => ({
      id: item.UserId.slice(0, 200),
      name: item.UserName?.slice(0, 80) || null,
      isSelf: event.BotId ? item.UserId === event.BotId : null,
      isBot: typeof item.IsBot === 'boolean' ? item.IsBot : null
    }))
  };
};

export const readMessageContext = async (event: MessageContextEvent, trigger: MessageContext['trigger']): Promise<MessageContext> => {
  if (Array.isArray(event.MessageMentions)) {
    return buildMessageContext(event, event.MessageMentions, trigger);
  }
  try {
    const [mention] = useMention();
    // The framework excludes bots by default. Fetch both sets using the same cached reader.
    const users = await mention.find();
    const bots = await mention.find({ IsBot: true });

    return buildMessageContext(event, Array.isArray(users.data) && Array.isArray(bots.data) ? [...users.data, ...bots.data] : undefined, trigger);
  } catch {
    return buildMessageContext(event, undefined, trigger);
  }
};
