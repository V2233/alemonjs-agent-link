import { SpeechError } from './speech-config';
export type LocalSpeech = { enabled: boolean; fallback: boolean; voice?: string };
export const localSpeechOptions = (value: unknown = {}): LocalSpeech => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpeechError('configuration', '本地音色设置无效。');
  const raw = value as Partial<LocalSpeech>;
  const result = {
    enabled: raw.enabled ?? true,
    fallback: raw.fallback ?? true,
    voice: typeof raw.voice === 'string' ? raw.voice.trim() || undefined : undefined
  };

  if (
    typeof result.enabled !== 'boolean' ||
    typeof result.fallback !== 'boolean' ||
    (raw.voice !== undefined && (typeof raw.voice !== 'string' || raw.voice.length > 200 || /[\r\n\0]/u.test(raw.voice)))
  )
    throw new SpeechError('configuration', '本地音色设置无效。');

  return result;
};
