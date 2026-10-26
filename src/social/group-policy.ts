export type GroupChatPolicy = {
  enabled: boolean;
  batchWindowMs: number;
  maxBatchWaitMs: number;
  maxBatchMessages: number;
  maxBatchChars: number;
  interjectChance: number;
  cooldownSeconds: number;
  maxPerHour: number;
  quietHours: [number, number];
  timezone: string;
  minRecentMessages: number;
  activeWindowSeconds: number;
  minRelevance: number;
  interests: string[];
  engagedSeconds: number;
  burstMax: number;
  burstWindowSeconds: number;
};

export type GroupChatConfig = Partial<GroupChatPolicy> & { overrides?: Record<string, Partial<GroupChatPolicy>> };
export type GroupReplyMode = 'direct' | 'engaged' | 'interject' | 'none';
export type GroupReplyDecision = { reply: boolean; mode: GroupReplyMode; reason: string; relevance: number };

export const defaultGroupChatPolicy: GroupChatPolicy = {
  enabled: true,
  batchWindowMs: 500,
  maxBatchWaitMs: 1500,
  maxBatchMessages: 24,
  maxBatchChars: 12000,
  interjectChance: 0.15,
  cooldownSeconds: 90,
  maxPerHour: 6,
  quietHours: [1, 8],
  timezone: 'Asia/Shanghai',
  minRecentMessages: 3,
  activeWindowSeconds: 300,
  minRelevance: 0.25,
  interests: ['吃饭', '美食', '游戏', '动漫', '猫', '鲸鱼', '睡觉', '天气', '奶茶', '表情包'],
  engagedSeconds: 180,
  burstMax: 8,
  burstWindowSeconds: 120
};

const checkPolicy = (policy: GroupChatPolicy): GroupChatPolicy => {
  const ranges: [number, number, number][] = [
    [policy.batchWindowMs, 0, 10000],
    [policy.maxBatchWaitMs, 1, 30000],
    [policy.maxBatchMessages, 1, 100],
    [policy.maxBatchChars, 200, 50000],
    [policy.cooldownSeconds, 0, 86400],
    [policy.maxPerHour, 0, 100],
    [policy.minRecentMessages, 1, 100],
    [policy.activeWindowSeconds, 1, 3600],
    [policy.engagedSeconds, 0, 1800],
    [policy.burstMax, 1, 100],
    [policy.burstWindowSeconds, 1, 3600]
  ];

  if (
    typeof policy.enabled !== 'boolean' ||
    ranges.some(([value, min, max]) => !Number.isSafeInteger(value) || value < min || value > max) ||
    policy.maxBatchWaitMs < policy.batchWindowMs ||
    !Number.isFinite(policy.interjectChance) ||
    policy.interjectChance < 0 ||
    policy.interjectChance > 1 ||
    !Number.isFinite(policy.minRelevance) ||
    policy.minRelevance < 0 ||
    policy.minRelevance > 1 ||
    !Array.isArray(policy.quietHours) ||
    policy.quietHours.length !== 2 ||
    policy.quietHours.some(hour => !Number.isInteger(hour) || hour < 0 || hour > 23) ||
    !Array.isArray(policy.interests) ||
    policy.interests.length > 100 ||
    policy.interests.some(word => typeof word !== 'string' || !word.trim() || word.length > 40)
  ) {
    throw new Error('groupChat 配置无效。');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: policy.timezone }).format();
  } catch {
    throw new Error('groupChat.timezone 无效。');
  }

  return { ...policy, quietHours: [...policy.quietHours], interests: [...policy.interests] };
};

export const getGroupChatPolicy = (config: GroupChatConfig = {}, channelId = ''): GroupChatPolicy => {
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    (config.overrides !== undefined && (!config.overrides || typeof config.overrides !== 'object' || Array.isArray(config.overrides)))
  ) {
    throw new Error('groupChat 配置无效。');
  }
  const { overrides = {}, ...base } = config;
  const merged = checkPolicy({ ...defaultGroupChatPolicy, ...base });

  for (const [id, override] of Object.entries(overrides)) {
    if (!id || id.length > 300 || !override || typeof override !== 'object' || Array.isArray(override)) {
      throw new Error('groupChat.overrides 配置无效。');
    }
    checkPolicy({ ...merged, ...override });
  }

  return checkPolicy({ ...merged, ...(Object.hasOwn(overrides, channelId) ? overrides[channelId] : {}) });
};

export const groupTopicRelevance = (texts: string[], interests: string[], memoryScore = 0): number => {
  const text = texts.join(' ').toLocaleLowerCase();
  const matches = new Set(interests.filter(word => text.includes(word.toLocaleLowerCase())));

  return Math.min(1, matches.size * 0.3 + Math.max(0, Math.min(1, memoryScore)) * 0.5);
};

export const isQuietHour = (hour: number, [from, to]: [number, number]): boolean =>
  from === to ? false : from < to ? hour >= from && hour < to : hour >= from || hour < to;

export const decideGroupReply = (input: {
  policy: GroupChatPolicy;
  direct: boolean;
  semantic?: boolean;
  owner: boolean;
  now: number;
  recentTimes: number[];
  replyTimes: number[];
  interjectTimes: number[];
  engagedUntil: number;
  relevance: number;
  random?: () => number;
}): GroupReplyDecision => {
  const { policy, now, relevance } = input;
  const decision = (reply: boolean, mode: GroupReplyMode, reason: string): GroupReplyDecision => ({ reply, mode, reason, relevance });
  const burst = input.replyTimes.filter(time => now - time < policy.burstWindowSeconds * 1000).length;

  if (burst >= policy.burstMax && !(input.owner && input.direct)) {
    return decision(false, 'none', '近期发言过多');
  }
  if (input.direct) {
    return decision(true, 'direct', '被明确唤醒');
  }
  if (!policy.enabled || policy.interjectChance === 0) {
    return decision(false, 'none', '自主参与关闭');
  }
  const hour = Number(new Intl.DateTimeFormat('en', { timeZone: policy.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));

  if (isQuietHour(hour, policy.quietHours)) {
    return decision(false, 'none', '静默时段');
  }
  if (!input.semantic && relevance < policy.minRelevance) {
    return decision(false, 'none', '话题相关度不足');
  }
  if (!input.semantic && input.engagedUntil > now) {
    return decision(true, 'engaged', '继续当前话题');
  }
  const interjections = input.interjectTimes.filter(time => now - time < 3600000);

  if (interjections.length >= policy.maxPerHour) {
    return decision(false, 'none', '已达每小时插话上限');
  }
  if (interjections.length && now - Math.max(...interjections) < policy.cooldownSeconds * 1000) {
    return decision(false, 'none', '插话冷却中');
  }
  if (!input.semantic && input.recentTimes.filter(time => now - time < policy.activeWindowSeconds * 1000).length < policy.minRecentMessages) {
    return decision(false, 'none', '近期消息不足');
  }
  if (input.semantic) {
    return decision(true, 'interject', '等待前置判断');
  }
  const chance = Math.min(0.8, policy.interjectChance * (1 + relevance * 4));

  return (input.random || Math.random)() < chance ? decision(true, 'interject', '参与相关话题') : decision(false, 'none', '本次不插话');
};
