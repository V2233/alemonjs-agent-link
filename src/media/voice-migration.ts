import type { MediaConfig } from './config';
import { voiceLibrary } from './voice-library';
import { speechOptions } from './speech-config';

/** Preserve original speech configuration; selecting the new preset makes it visible in the library. */
export const migrateLegacyVoice = (media: Partial<MediaConfig>): Partial<MediaConfig> => {
  if (!media.speech || media.activeVoice || media.voices?.length) throw new Error('仅支持尚未使用音色库的原有语音配置');
  speechOptions(media.speech);
  const voice = { id: 'legacy-voice', name: `${media.speech.engine || 'auto'} 原有音色`, enabled: true, speech: { ...media.speech } };

  voiceLibrary([voice]);

  return { ...media, voices: [voice], activeVoice: voice.id };
};
