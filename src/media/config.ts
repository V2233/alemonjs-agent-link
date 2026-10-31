import { localSpeechOptions, type LocalSpeech } from './local-speech';
import { voiceLibrary, selectVoice, type VoicePreset } from './voice-library';
import { getAppConfigValue } from 'alemonjs';
import { join, resolve } from 'node:path';
import { speechOptions, type SpeechOptions } from './speech-config';

export const DEFAULT_STICKER_CAPACITY = 1200;
export const MAX_STICKER_CAPACITY = 10000;

export type MediaProvider = { baseUrl: string; apiKey: string; model: string; voice?: string; protocol?: 'openai' | 'siliconflow' };
export type ImageGenerationProvider = MediaProvider & { responseFormat?: 'b64_json' | 'url' | 'auto'; size: string; stylePrompt: string; ownerOnly: boolean };
export type ImagePreset = { id: string; name: string; enabled: boolean; provider: ImageGenerationProvider };
export type MediaConfig = {
  dshImageFallback?: boolean;
  voiceRotation?: boolean;
  imageLibrary?: ImagePreset[];
  activeImage?: string;
  voices?: VoicePreset[];
  activeVoice?: string;
  localSpeech?: LocalSpeech;
  vision?: MediaProvider;
  asr?: MediaProvider;
  tts?: MediaProvider;
  imageGen?: ImageGenerationProvider;
  speech?: Partial<SpeechOptions>;
  // Empty means any public HTTPS host; a nonempty list restricts hosts exactly.
  allowedHosts: string[];
  timeoutMs: number;
  maxBytes: number;
  maxAttachments: number;
  ttsMaxChars: number;
  stickerRoot?: string;
  stickerMaxItems: number;
};
export class MediaError extends Error {}
export const unavailableMediaReply = '当前附件类型暂不支持，或识别服务尚未配置。语音可提供平台转写；图片、视频可改发截图或文字说明。';
export class MediaUnavailableError extends MediaError {
  constructor() {
    super(unavailableMediaReply);
  }
}
const defaultStickerRoot = (): string => resolve(process.env.AGENT_LINK_DATA_DIR ?? join(process.cwd(), '.data', 'agent-link'), 'stickers');
const provider = (value: unknown, allowLocal = false): MediaProvider | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    throw new MediaError('媒体服务配置无效。');
  }
  const input = value as MediaProvider;

  if (![input.baseUrl, input.model].every(item => typeof item === 'string' && item.trim())) {
    throw new MediaError('媒体服务需要独立配置 baseUrl、apiKey 和 model。');
  }
  let url: URL;

  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new MediaError('媒体服务地址无效。');
  }
  const local = allowLocal && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new MediaError('媒体服务地址必须是无凭证、无查询参数的 HTTPS 地址。');
  }
  if (!local && (typeof input.apiKey !== 'string' || !input.apiKey.trim())) {
    throw new MediaError('远程媒体服务需要独立 apiKey。');
  }
  if (input.voice !== undefined && (typeof input.voice !== 'string' || !input.voice.trim())) {
    throw new MediaError('语音音色配置无效。');
  }

  if (input.protocol !== undefined && !['openai', 'siliconflow'].includes(input.protocol)) throw new MediaError('媒体服务协议无效。');

  return {
    ...(input.protocol ? { protocol: input.protocol } : {}),
    baseUrl: input.baseUrl.replace(/\/+$/u, ''),
    apiKey: input.apiKey || '',
    model: input.model,
    voice: input.voice
  };
};

const imageProvider = (value: unknown): ImageGenerationProvider | undefined => {
  const base = provider(value, true);

  if (!base) return undefined;
  const raw = value as ImageGenerationProvider;

  if (raw.responseFormat !== undefined && !['b64_json', 'url', 'auto'].includes(raw.responseFormat)) throw new MediaError('生图响应格式无效。');
  const size = raw.size ?? '1024x1024';
  const stylePrompt = raw.stylePrompt ?? '';
  const ownerOnly = raw.ownerOnly ?? false;

  if (
    typeof size !== 'string' ||
    !/^\d{2,4}x\d{2,4}$/u.test(size) ||
    typeof stylePrompt !== 'string' ||
    stylePrompt.length > 2000 ||
    typeof ownerOnly !== 'boolean'
  ) {
    throw new MediaError('生图服务 size、stylePrompt 或 ownerOnly 配置无效。');
  }

  return { ...base, size, stylePrompt, ownerOnly, ...(raw.responseFormat ? { responseFormat: raw.responseFormat } : {}) };
};

export const getMediaConfig = (value: { media?: Partial<MediaConfig> } = getAppConfigValue()): MediaConfig => {
  const raw = value?.media ?? {};
  const config: MediaConfig = {
    dshImageFallback: raw.dshImageFallback ?? false,
    voiceRotation: raw.voiceRotation ?? false,
    imageLibrary: imageLibrary(raw.imageLibrary),
    activeImage: raw.activeImage,
    voices: voiceLibrary(raw.voices),
    activeVoice: raw.activeVoice,
    localSpeech: localSpeechOptions(raw.localSpeech),
    allowedHosts: raw.allowedHosts ?? [],
    timeoutMs: raw.timeoutMs ?? 60000,
    maxBytes: raw.maxBytes ?? 10 * 1024 * 1024,
    maxAttachments: raw.maxAttachments ?? 3,
    ttsMaxChars: raw.ttsMaxChars ?? 800,
    stickerRoot: raw.stickerRoot ?? defaultStickerRoot(),
    stickerMaxItems: raw.stickerMaxItems ?? DEFAULT_STICKER_CAPACITY,
    vision: provider(raw.vision, true),
    asr: provider(raw.asr, true),
    tts: provider(raw.tts, true),
    imageGen: imageProvider(raw.imageGen),
    speech: speechOptions(raw.speech)
  };

  if (typeof config.voiceRotation !== 'boolean') throw new MediaError('音色轮转设置无效。');
  if (
    !Array.isArray(config.allowedHosts) ||
    config.allowedHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/u.test(host) || host.startsWith('.'))
  ) {
    throw new MediaError('media.allowedHosts 必须是精确域名列表，不支持通配符。');
  }
  for (const [number, min, max] of [
    [config.timeoutMs, 1000, 120000],
    [config.maxBytes, 1024, 25 * 1024 * 1024],
    [config.maxAttachments, 1, 5],
    [config.ttsMaxChars, 1, 4000],
    [config.stickerMaxItems, 1, MAX_STICKER_CAPACITY]
  ]) {
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new MediaError('媒体大小、超时或次数配置超出范围。');
    }
  }
  if (config.stickerRoot !== undefined && (typeof config.stickerRoot !== 'string' || !config.stickerRoot.trim())) {
    throw new MediaError('表情素材目录配置无效。');
  }

  if (config.activeVoice !== undefined && typeof config.activeVoice !== 'string') throw new MediaError('音色ID无效。');
  selectVoice(config, true);

  if (typeof config.dshImageFallback !== 'boolean') throw new MediaError('DSH 生图兜底开关无效');
  if (config.activeImage !== undefined && typeof config.activeImage !== 'string') throw new MediaError('生图配置ID无效');
  if (config.activeImage) {
    const selected = config.imageLibrary?.find(item => item.id === config.activeImage);

    if (!selected) throw new MediaError('所选生图配置不存在');
    config.imageGen = selected.enabled ? selected.provider : undefined;
  }

  return config;
};

export const imageLibrary = (value: unknown): ImagePreset[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new MediaError('生图库最多100项');
  const ids = new Set<string>();

  return value.map(item => {
    if (
      !item ||
      typeof item !== 'object' ||
      !/^[a-zA-Z0-9_-]{1,64}$/u.test(item.id) ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 80 ||
      typeof item.enabled !== 'boolean'
    )
      throw new MediaError('生图配置名称、ID或状态无效');
    ids.add(item.id);
    const parsed = imageProvider(item.provider);

    if (!parsed) throw new MediaError('需要生图服务配置');

    return { id: item.id, name: item.name.trim(), enabled: item.enabled, provider: parsed };
  });
};
