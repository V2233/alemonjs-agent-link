import { getAffinityStore } from './affinity';
import { getPersonaStore } from './personas';
import { isQuietHour } from '../social/group-policy';
import { voiceMotivation, type VoiceSituation } from './voice-policy';
import { createHash } from 'node:crypto';
import type { DSHBridgeConfig } from '../dsh/client';
import type { MediaConfig } from '../media/config';
import type { Sticker } from '../media/stickers';
import type { GroupChatPolicy } from '../social/group-policy';
import type { PersonaScope } from './personas';
import { getMoodStore, moodOptions } from './mood';
import { groupPolicy, groupVoicePolicy } from '../social/group-settings';

export const expressionOptions = (config: DSHBridgeConfig) => {
  const raw = config.modules?.settings?.expression || {};
  const options = {
    automatic: raw.automatic ?? true,
    voiceChance: raw.voiceChance ?? 0.15,
    stickerChance: raw.stickerChance ?? 0.35,
    // 没有匹配到话题相关表情时，是否随手发一个（默认不发）。
    stickerFallback: raw.stickerFallback ?? false,
    // 识别到“在不在/晚安”等明确意图时，绕过概率抽样尝试一次匹配表情。
    stickerIntentAlways: raw.stickerIntentAlways ?? true,
    // either=只发文字或只发匹配表情；both=正文后再补一张（旧行为）。
    stickerMode: raw.stickerMode ?? 'either',
    // 允许模型用 <voice>...</voice> 主动选择语音；默认关闭，避免所有回复被缓冲。
    modelVoice: raw.modelVoice ?? false,
    // 群聊短回复疑似客服腔时，允许一次便宜模型改写；失败回退原文。
    socialPolish: raw.socialPolish ?? true,
    delayMs: raw.delayMs ?? [0, 0]
  };

  if (
    typeof options.automatic !== 'boolean' ||
    typeof options.stickerFallback !== 'boolean' ||
    typeof options.stickerIntentAlways !== 'boolean' ||
    typeof options.modelVoice !== 'boolean' ||
    typeof options.socialPolish !== 'boolean' ||
    !['either', 'both'].includes(String(options.stickerMode)) ||
    !Number.isFinite(options.voiceChance) ||
    Number(options.voiceChance) < 0 ||
    Number(options.voiceChance) > 1 ||
    !Number.isFinite(options.stickerChance) ||
    Number(options.stickerChance) < 0 ||
    Number(options.stickerChance) > 1 ||
    !Array.isArray(options.delayMs) ||
    options.delayMs.length !== 2 ||
    options.delayMs.some(value => !Number.isSafeInteger(value) || value < 0 || value > 3000) ||
    options.delayMs[0] > options.delayMs[1]
  ) {
    throw new Error('expression 设置无效。');
  }

  return {
    automatic: options.automatic,
    voiceChance: Number(options.voiceChance),
    stickerChance: Number(options.stickerChance),
    stickerFallback: options.stickerFallback,
    stickerIntentAlways: options.stickerIntentAlways,
    stickerMode: options.stickerMode as 'either' | 'both',
    modelVoice: options.modelVoice,
    socialPolish: options.socialPolish,
    delayMs: options.delayMs as [number, number]
  };
};
const sample = (id: string, purpose: string): number =>
  createHash('sha256')
    .update(JSON.stringify([id, purpose]))
    .digest()
    .readUInt32BE(0) / 0x100000000;

type StickerIntent = { names: string[]; categories: string[]; tags: string[]; context: string[] };
const INTENTS: { pattern: RegExp; intent: StickerIntent }[] = [
  {
    pattern: /在不在|在吗|在么|在嘛|有人吗|在不在呀/u,
    intent: { names: ['在呢'], categories: ['日常'], tags: ['招呼', '回应', '日常'], context: ['招呼', '回应', '在呢'] }
  },
  {
    pattern: /早安|早上好/u,
    intent: { names: ['早安', '早上好'], categories: ['问候'], tags: ['早安', '早上好', '问候'], context: ['早晨', '问候'] }
  },
  {
    pattern: /晚安|睡了|困了|睡觉|好梦/u,
    intent: { names: ['晚安', '睡了'], categories: ['晚安'], tags: ['晚安', '困'], context: ['睡前', '困倦', '晚安'] }
  },
  {
    pattern: /哈哈|笑死|好笑|开心|好耶|太好/u,
    intent: { names: ['好耶', '开心', '笑死', '哈哈'], categories: ['开心'], tags: ['开心', '笑'], context: ['庆祝', '好消息', '开心'] }
  },
  {
    pattern: /生气|好烦|讨厌|不满|气死/u,
    intent: { names: ['生气', '不满'], categories: ['不满'], tags: ['生气', '不满'], context: ['不满', '生气'] }
  },
  {
    pattern: /委屈|难过|想哭|伤心|哭死/u,
    intent: { names: ['抱抱', '安慰'], categories: ['安慰'], tags: ['抱抱', '安慰'], context: ['陪伴', '安慰'] }
  },
  {
    pattern: /害羞|不好意思|脸红/u,
    intent: { names: ['害羞'], categories: ['害羞'], tags: ['害羞'], context: ['害羞'] }
  },
  {
    pattern: /得意|厉害|牛啊|太强|崇拜/u,
    intent: { names: ['得意', '厉害'], categories: ['得意'], tags: ['得意', '厉害'], context: ['自夸', '得意'] }
  },
  {
    pattern: /调皮|略略略|逗你|哼哼/u,
    intent: { names: ['调皮', '哼哼'], categories: ['调皮'], tags: ['调皮', '搞怪'], context: ['互损', '调皮', '得意'] }
  }
];

export const stickerIntent = (text: string): StickerIntent | undefined => {
  if (!text || /[“”「」"<>]|他说|她说|有人说|不要|别再|不许|并不|不是|不(?:开心|难过|生气|困|委屈)|怎么|如何|为什么|什么叫/u.test(text)) return undefined;

  return INTENTS.find(entry => entry.pattern.test(text))?.intent;
};
export const hasStickerIntent = (text: string): boolean => Boolean(stickerIntent(text));
export const selectIntentSticker = (items: Sticker[], userText: string): Sticker | undefined => {
  const intent = stickerIntent(userText);

  if (!intent) return undefined;

  const exact = items.find(item => Boolean(item.name && intent.names.includes(item.name)));

  if (exact) return exact;
  // Require a specific expression tag: a broad category such as 日常 is not enough.
  const specific = intent.tags.filter(tag => !['日常', '回应', '问候'].includes(tag));

  return items.find(item => item.tags.some(tag => specific.includes(tag)));
};
const INTENT_WORDS =
  /在不在|在吗|在么|在嘛|有人吗|早安|早上好|晚安|睡了|困了|睡觉|好梦|哈哈|笑死|好笑|开心|好耶|太好|生气|好烦|讨厌|不满|气死|委屈|难过|想哭|伤心|哭死|害羞|不好意思|脸红|得意|厉害|牛啊|太强|崇拜|调皮|略略略|逗你|哼哼/gu;

/**
 * A sticker can replace a greeting/acknowledgement, but not extra information.
 * Keep the text when the user asked for more, or the answer contains facts/steps/links.
 */
export const needsTextSupplement = (userText: string, answer: string): boolean => {
  const residual = userText
    .replace(/^(?:大肥鱼|小肥鱼|肥鱼|小鲸鱼)[，,：:\s]*/u, '')
    .replace(INTENT_WORDS, '')
    .replace(/[\s，,。.!！?？~～呀啊嘛哦嗯哈]/gu, '');
  const simpleEmotion = hasStickerIntent(userText) && /^(?:我|今天|有点|真的|好|很|太|了|死|啦|呢)*$/u.test(residual);
  const substantive = /https?:\/\/|```|\n[-*]|\d|[%¥$]|因为|所以|但是|需要|建议|步骤|报错|错误|地址|链接|价格|时间|版本/u.test(answer);
  // Only suppress a reply that the sticker itself can convey; short facts still need text.
  const extraReply = answer
    .replace(/在(?:的|呢|听)?|早(?:安|上好)?|晚安|好梦|哈哈+|笑死|好耶|开心|抱(?:抱|一下)|摸摸|拍拍|哼哼?|恭喜|给你|给我|你|我/gu, '')
    .replace(/[\s，,。.!！?？~～呀啊嘛哦嗯哈啦呢]/gu, '');

  return !simpleEmotion || Array.from(answer).length > 24 || substantive || extraReply.length > 0;
};

const mood = (config: DSHBridgeConfig, scope: PersonaScope): number =>
  config.modules?.disabled?.includes('mood') ? 60 : getMoodStore(config).snapshot(scope, moodOptions(config), config.retentionDays).value;

export const planExpression = (config: DSHBridgeConfig, scope: PersonaScope, inputId: string, media?: MediaConfig, situation?: VoiceSituation) => {
  const options = expressionOptions(config);
  const value = scope.platform && scope.channelId ? mood(config, scope) : 60;
  const automatic = options.automatic && !config.modules?.disabled?.includes('expression');
  const expressiveness = value >= 75 ? 1.25 : value < 45 ? 0.5 : 1;
  // 群设置可以关掉本群语音或自动语音；私聊与未设置的群沿用全局。
  const voice = scope.platform && scope.channelId ? groupVoicePolicy(config, scope.channelId, scope.platform) : { allowed: true, auto: true };

  let affinity = 50;

  if (situation?.userId && !config.modules?.disabled?.includes('affinity')) {
    const personaId = String(getPersonaStore(config).selected(scope) || config.modules?.settings?.persona?.defaultId || config.persona);

    if (personaId === 'dafeiyu') affinity = getAffinityStore(config).snapshot({ ...scope, userId: situation.userId, personaId }).score;
  }
  const policy = groupPolicy(config, scope.channelId, scope.platform);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: policy.timezone }).format(situation?.now ?? Date.now()));
  const motivation = voiceMotivation(situation && { ...situation, affinity, quiet: isQuietHour(hour, policy.quietHours) }, value);

  return {
    voice: Boolean(
      automatic &&
      voice.allowed &&
      voice.auto &&
      !config.modules?.disabled?.includes('voice') &&
      (media?.tts?.voice || media?.speech) &&
      motivation > 0 &&
      sample(inputId, 'voice') < Math.min(1, options.voiceChance * motivation)
    ),
    sticker: Boolean(automatic && media?.stickerRoot && sample(inputId, 'sticker') < Math.min(1, options.stickerChance * expressiveness)),
    delayMs: automatic
      ? Math.min(3000, Math.round((options.delayMs[0] + sample(inputId, 'delay') * (options.delayMs[1] - options.delayMs[0])) * (value < 45 ? 1.2 : 1)))
      : 0
  };
};

export const automaticVoiceText = (text: string, limit: number): boolean =>
  Boolean(text.trim()) && Array.from(text).length <= Math.min(100, limit) && !/```|https?:\/\/|\|.*\||\[沉默\]|\n[-*]|配置|命令|步骤|首先|其次/u.test(text);

export const selectExpressionSticker = (
  items: Sticker[],
  text: string,
  moodValue: number,
  inputId: string,
  fallback = false,
  userText = ''
): Sticker | undefined => {
  const related = moodValue >= 75 ? ['开心', '愉快', '高兴', '快乐', '笑'] : moodValue < 45 ? ['低落', '难过', '疲惫', '叹气'] : ['平和', '日常', '点头'];
  const intent = stickerIntent(userText);
  const ranked = items
    .map(item => {
      let score = item.tags.reduce((sum, tag) => sum + (text.includes(tag) ? 3 : related.includes(tag) ? 1 : 0), 0);

      if (intent) {
        if (item.name && intent.names.includes(item.name)) score += 40;
        else if (item.name && intent.names.some(name => item.name?.includes(name))) score += 10;
        if (intent.categories.includes(item.category || '')) score += 8;
        if (intent.tags.some(tag => item.tags.includes(tag))) score += 6;
        if (item.context && intent.context.some(keyword => item.context?.includes(keyword))) score += 4;
      }

      return { item, score, tie: sample(inputId, item.id) };
    })
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.tie - b.tie);

  if (ranked[0]) return ranked[0].item;
  if (!fallback || !items.length) return undefined;

  // A deterministic per-input shuffle gives an unpredictable but retry-stable fallback.
  return [...items].sort((a, b) => sample(inputId, a.id) - sample(inputId, b.id))[0];
};

export const moodGroupPolicy = (config: DSHBridgeConfig, scope: PersonaScope, policy: GroupChatPolicy): GroupChatPolicy => {
  if (!scope.platform || config.modules?.disabled?.includes('mood')) {
    return policy;
  }
  const value = mood(config, scope);

  // Only extend the configured cooldown; quiet hours, burst brakes and hourly limits remain hard bounds.
  return value < 45 ? { ...policy, cooldownSeconds: Math.min(86400, Math.ceil(policy.cooldownSeconds * (value < 25 ? 2 : 1.5))) } : policy;
};

// Only successful deliveries enter this session-local recent history.
const recentStickers = new Map<string, { id: string; at: number }[]>();

export const recordExpressionSticker = (scope: string, id: string, now = Date.now()): void => {
  const recent = (recentStickers.get(scope) || []).filter(item => now - item.at < 30 * 60_000 && item.id !== id);

  recentStickers.delete(scope);
  recentStickers.set(scope, [...recent, { id, at: now }].slice(-3));
  while (recentStickers.size > 1000) recentStickers.delete(recentStickers.keys().next().value);
};
export const freshExpressionStickers = (items: Sticker[], scope: string, now = Date.now()): Sticker[] => {
  const recent = (recentStickers.get(scope) || []).filter(item => now - item.at < 30 * 60_000);

  if (!recent.length) recentStickers.delete(scope);
  const excluded = new Set(recent.map(item => item.id));

  return items.filter(item => !excluded.has(item.id));
};
