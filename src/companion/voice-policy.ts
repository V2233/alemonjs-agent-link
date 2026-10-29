import { keywordMoodDelta } from './mood';

/** Voice is an occasional emotional expression, with limits shared by all automatic entrances. */
export type VoiceSituation = { userText: string; private?: boolean; autonomous?: boolean; now?: number; userId?: string; affinity?: number; quiet?: boolean };
export const explicitVoiceRequest = (text: string): boolean => {
  // A quoted request is data, but “please read ‘hello’” remains an explicit request.
  const request = text.replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/gu, '');

  return (
    !/他说|她说|有人说|不要.*(?:语音|朗读)|别.*(?:语音|朗读)|不方便听|语音.*(?:频繁|太多|烦|关闭)|为什么.*语音|只(?:发|用).*文字/u.test(request) &&
    /(?:用|发|来|说|回|听).{0,6}语音|朗读|念(?:出来|给我|一下)|\/语音/u.test(request)
  );
};

export const voiceMotivation = (situation: VoiceSituation | undefined, mood: number): number => {
  if (!situation || situation.autonomous || situation.quiet) return 0;
  const text = situation.userText;

  if (
    !text.trim() ||
    text.length > 160 ||
    /语音|声音|音色|不方便听|开会|上课|安静|文字|配置|代码|报错|命令|步骤|教程|怎么|如何|为什么|多少钱|地址|链接|```|https?:\/\//u.test(text)
  )
    return 0;
  // An everyday greeting, a sad word or a high mood alone is not a reason to speak.
  if (/[“”「」"<>]|他说|她说|有人说|并不|不是|没考上|没通过|没成功/u.test(text)) return 0;
  const anger = mood < 45 && keywordMoodDelta(text) < 0;
  const intenseJoy = mood >= 75 && /终于|总算/u.test(text) && /考上了|通过了|成功了|赢了/u.test(text) && /太开心|好耶|激动/u.test(text);

  if (!anger && !intenseJoy) return 0;

  return (anger ? 0.8 : 0.6) * ((situation.affinity ?? 50) >= 80 ? 1.1 : 1) * (situation.private ? 1 : 0.65);
};

/** The generated reply must actually carry the emotion; never read an ordinary explanation aloud. */
export const emotionalVoiceReply = (userText: string, reply: string): boolean =>
  keywordMoodDelta(userText) < 0 ? /够了|过分|别这样|不接受|不许|生气|别再|尊重/u.test(reply) : /太好了|好耶|开心|恭喜|激动|啊[！!]/u.test(reply);

type VoiceHistory = { last: number; sent: number[]; textTurns: number };
const histories = new Map<string, VoiceHistory>();
const history = (key: string, now: number): VoiceHistory => {
  for (const [id, entry] of histories) if (now - entry.last >= 3600000) histories.delete(id);

  return histories.get(key) || { last: 0, sent: [], textTurns: 2 };
};

/** In-process limits: at least 10 minutes and two text turns apart; at most two per hour. */
export const automaticVoiceAvailable = (key: string, now = Date.now()): boolean => {
  const entry = history(key, now);

  return (!entry.last || now - entry.last >= 600000) && entry.textTurns >= 2 && entry.sent.filter(at => now - at < 3600000).length < 2;
};
export const recordVoiceTurn = (key: string, voice: boolean, now = Date.now()): void => {
  const entry = history(key, now);

  if (voice) {
    entry.last = now;
    entry.sent = [...entry.sent.filter(at => now - at < 3600000), now];
    entry.textTurns = 0;
  } else entry.textTurns++;
  histories.set(key, entry);
};
export const voiceConversationKey = (root: string, platform: string, channelId: string): string => JSON.stringify([root, platform, channelId]);
