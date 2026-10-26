export type BotMention = {
  UserId: string;
  UserName?: string;
};

type AdminEvent = {
  IsAdmin?: boolean;
};

export const getSessionId = (channelId: string): string =>
  channelId.startsWith('private:') ? `dsh:qq:private:${channelId.slice('private:'.length)}` : `dsh:qq:group:${channelId}`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const extractPrompt = (messageText: string, bot: BotMention): string => {
  const patterns = [new RegExp(`^\\s*<@!?${escapeRegExp(bot.UserId)}>\\s*`), new RegExp(`^\\s*\\[CQ:at,qq=${escapeRegExp(bot.UserId)}\\]\\s*`)];

  if (bot.UserName) {
    patterns.push(new RegExp(`^\\s*@${escapeRegExp(bot.UserName)}\\s*`));
  }

  return patterns.reduce((text, pattern) => text.replace(pattern, ''), messageText).trim();
};

export const canReset = (event: { IsMaster: boolean }): boolean => event.IsMaster || Boolean((event as AdminEvent).IsAdmin);

export type ConversationEvent = { IsPrivate?: boolean; IsMaster?: boolean; Platform?: string; UserId?: string; UserKey?: string; ChannelId?: string };

export const getConversationId = (event: ConversationEvent): string => {
  if (!event.IsPrivate) {
    return event.ChannelId || '';
  }
  // Missing identities must never share a fallback owner session.
  if (!event.Platform || !event.UserId) {
    return '';
  }

  return `private:${JSON.stringify([event.Platform, event.UserId])}`;
};

export const canPrivateChat = (event: ConversationEvent, access: 'owner' | 'all'): boolean => Boolean(event.IsMaster) || access === 'all';
export const isPrivateChatText = (text: string): boolean => Boolean(text.trim()) && !text.trimStart().startsWith('/');
