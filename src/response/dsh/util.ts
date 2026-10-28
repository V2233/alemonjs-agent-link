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
export const canPrivateChatWithKey = async (event: ConversationEvent, access: 'owner' | 'all'): Promise<boolean> => {
  if (canPrivateChat(event, access)) return true;
  if (!event.IsPrivate || !event.Platform || !event.UserId) return false;
  try {
    const [{ withBudgetScope }, { getBoundCredential }] = await Promise.all([import('../../billing/budget'), import('../../credentials/scoped')]);

    return Boolean(await withBudgetScope({ platform: event.Platform, userId: event.UserId, channelId: getConversationId(event) }, getBoundCredential));
  } catch {
    return false;
  }
};
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

const GENERIC_HELP_WAKES = new Set(['帮我', '帮忙', '帮一下', '帮个忙', '求助', '求解', '请教']);

/**
 * 高置信度的“喊我”：名字在句首，后面是标点/空白/结束，而不是“肥鱼说……”
 * 或“他们说肥鱼……”。这类消息可以不调用分类模型，直接进入回复链路；
 * 泛化的“帮我/求助”不算，避免把普通群聊里的求助都当成叫它。
 */
export const startsWithAddressName = (text: string, names: string[]): boolean => {
  const input = String(text ?? '').trim();

  if (!input || input.startsWith('/')) {
    return false;
  }
  const normalized = input.toLowerCase();

  return names.some(name => {
    if (!name || GENERIC_HELP_WAKES.has(name)) {
      return false;
    }
    const keyword = name.toLowerCase();

    if (!normalized.startsWith(keyword)) {
      return false;
    }

    return input.length === name.length || /^[\s，,。！!？?：:、~～]/u.test(input.slice(name.length));
  });
};
