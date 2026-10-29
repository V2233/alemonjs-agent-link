import { createHash } from 'node:crypto';
import { templateBalance, type EndpointBalance } from '../model-pool/balance';
import type { MediaConfig } from './config';
import type { VoicePreset } from './voice-library';

const balances = new Map<string, EndpointBalance>();
const pending = new Map<string, Promise<EndpointBalance>>();

export const voiceAccountKey = (config: MediaConfig, voice?: VoicePreset): string => {
  const speech = voice?.speech || config.speech;
  const openai = speech?.engine === 'openai' || speech?.engine === 'auto';

  return createHash('sha256')
    .update(JSON.stringify([openai ? config.tts?.baseUrl : speech?.url, openai ? config.tts?.apiKey : speech?.apiKey, voice?.balanceUrl]))
    .digest('hex');
};
export const cachedVoiceBalance = (config: MediaConfig, voice: VoicePreset) => balances.get(voiceAccountKey(config, voice));
export const voiceBalanceExhausted = (config: MediaConfig): boolean => {
  const voice = config.voices?.find(item => item.id === config.activeVoice);
  const balance = voice && cachedVoiceBalance(config, voice);

  return Boolean(balance && Date.now() - balance.checkedAt < 60_000 && balance.status === 'exhausted');
};
export const fetchVoiceBalance = async (config: MediaConfig, voice: VoicePreset, force = false): Promise<EndpointBalance> => {
  const key = voiceAccountKey(config, voice);
  const cached = balances.get(key);

  if (!force && cached && Date.now() - cached.checkedAt < 60_000) return cached;
  if (pending.has(key)) return pending.get(key);
  const job = (async (): Promise<EndpointBalance> => {
    let result: EndpointBalance;
    const engine = voice.speech.engine;

    if (engine === 'system' || engine === 'edge') result = { text: '无供应商余额接口', status: 'unsupported', checkedAt: Date.now() };
    else if (!voice.balanceUrl) result = { text: '未配置额度查询接口', status: 'unsupported', checkedAt: Date.now() };
    else {
      try {
        const apiKey = engine === 'openai' || engine === 'auto' ? config.tts?.apiKey : voice.speech.apiKey;

        if (!apiKey) throw new Error('未配置凭证');
        result = (await templateBalance({ apiKey }, voice.balanceUrl, AbortSignal.timeout(6000))) || {
          text: '未知额度',
          status: 'unknown',
          checkedAt: Date.now()
        };
      } catch {
        result = { text: '查询失败', status: 'failed', checkedAt: Date.now() };
      }
    }
    if (balances.size >= 1000) balances.clear();
    balances.set(key, result);

    return result;
  })().finally(() => pending.delete(key));

  pending.set(key, job);

  return await job;
};
