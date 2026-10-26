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

// Require a name boundary: mentioning a fish in the middle of a sentence is not a wake-up.
export const extractWakePrompt = (text: string, names: string[]): string | null => {
  const input = text.trim();

  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (input === name) {
      return '用户喊了你一声，请简短回应。';
    }
    if (input.startsWith(name) && /^[\s，,。！!？?：:、]/u.test(input.slice(name.length))) {
      return (
        input
          .slice(name.length)
          .replace(/^[\s，,。！!？?：:、]+/u, '')
          .trim() || '用户喊了你一声，请简短回应。'
      );
    }
  }

  return null;
};

export const describeSpeaker = (event: { UserId?: string; UserName?: string; IsMaster?: boolean }): string =>
  JSON.stringify({
    id: event.UserId || 'unknown',
    name: (event.UserName || '').slice(0, 80),
    owner: Boolean(event.IsMaster)
  });
