export type BotMention = {
  UserId: string;
  UserName?: string;
};

type AdminEvent = {
  IsAdmin?: boolean;
};

export const getSessionId = (channelId: string): string => `dsh:qq:group:${channelId}`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const extractPrompt = (messageText: string, bot: BotMention): string => {
  const patterns = [new RegExp(`^\\s*<@!?${escapeRegExp(bot.UserId)}>\\s*`), new RegExp(`^\\s*\\[CQ:at,qq=${escapeRegExp(bot.UserId)}\\]\\s*`)];

  if (bot.UserName) {
    patterns.push(new RegExp(`^\\s*@${escapeRegExp(bot.UserName)}\\s*`));
  }

  return patterns.reduce((text, pattern) => text.replace(pattern, ''), messageText).trim();
};

export const canReset = (event: { IsMaster: boolean }): boolean => event.IsMaster || Boolean((event as AdminEvent).IsAdmin);
