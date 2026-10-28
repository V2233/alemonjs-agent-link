import { groupAdminStatus, type MemberRoleEvent } from '../../platform/member-role';

export type BotMention = {
  UserId: string;
  UserName?: string;
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

export const canReset = (event: { IsMaster: boolean } & MemberRoleEvent): boolean => event.IsMaster || groupAdminStatus(event) === true;

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
export const isPrivateChatText = (text: string): boolean => typeof text === 'string' && Boolean(text.trim()) && !text.trimStart().startsWith('/');

// Commands belong to the command router. Wake words may occur anywhere in a message.
export const extractWakePrompt = (text: string, names: string[]): string | null => {
  const input = String(text ?? '').trim();

  if (!input || input.startsWith('/')) {
    return null;
  }
  const normalized = input.toLowerCase();

  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const keyword = name.toLowerCase();
    // Latin aliases must not accidentally match inside unrelated identifiers.
    const found = /^[a-z0-9 -]+$/iu.test(name)
      ? new RegExp(`(?<![a-z0-9_])${escapeRegExp(keyword)}(?![a-z0-9_])`, 'u').test(normalized)
      : normalized.includes(keyword);

    if (!name || !found) {
      continue;
    }
    if (normalized === keyword && name !== '帮我') {
      return '用户喊了你一声，请简短回应。';
    }
    // Keep help requests complete: removing “帮我” can change the user's meaning.
    if (name !== '帮我' && normalized.startsWith(keyword) && /^[\s，,。！!？?：:、]/u.test(input.slice(name.length))) {
      return (
        input
          .slice(name.length)
          .replace(/^[\s，,。！!？?：:、]+/u, '')
          .trim() || '用户喊了你一声，请简短回应。'
      );
    }

    return input;
  }

  return null;
};

export const describeSpeaker = (event: { UserId?: string; UserName?: string; IsMaster?: boolean }): string =>
  JSON.stringify({
    id: event.UserId || 'unknown',
    name: (event.UserName || '').slice(0, 80),
    owner: Boolean(event.IsMaster)
  });
