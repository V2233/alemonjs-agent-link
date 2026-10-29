import { getConfig } from 'alemonjs';
import { getAdminStore } from './admin-panel';
import { getMediaConfig } from '../media/config';
import { cachedVoiceBalance, fetchVoiceBalance } from '../media/voice-status';
import { voiceLibrary } from '../media/voice-library';

const probeKey = (voice: { id: string; probeUrl?: string }) => JSON.stringify([voice.id, voice.probeUrl]);
const probes = new Map<string, { checkedAt: number; status: string; httpStatus?: number }>();

export const voiceSnapshot = () => {
  const config = getMediaConfig();

  return {
    activeVoice: config.activeVoice,
    sampledAt: Date.now(),
    voices: (config.voices || []).map(voice => ({
      id: voice.id,
      name: voice.name,
      enabled: voice.enabled,
      engine: voice.speech.engine,
      fallback: voice.speech.fallback,
      probe: probes.get(probeKey(voice)),
      balance: cachedVoiceBalance(config, voice)
    }))
  };
};
export const voiceBalances = async (id?: unknown) => {
  const config = getMediaConfig();

  if (id !== undefined && (typeof id !== 'string' || !config.voices?.some(voice => voice.id === id))) throw new Error('音色不存在');
  const voices = (config.voices || []).filter(voice => id === undefined || voice.id === id);

  // Bound diagnostic concurrency, including while voices are disabled.
  for (let i = 0; i < voices.length; i += 2) await Promise.all(voices.slice(i, i + 2).map(voice => fetchVoiceBalance(config, voice, true)));

  return voiceSnapshot();
};
export const readVoiceSettings = async () => {
  const snapshot = await getAdminStore().read();
  const media = JSON.parse(snapshot.source)['alemonjs-agent-link']?.media || {};

  return { revision: snapshot.revision, voices: media.voices || [], activeVoice: media.activeVoice || '' };
};
export const updateVoiceSettings = async (input: unknown) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的音色设置');
  const body = input as { revision: string; voices: unknown; activeVoice: string };

  if (
    Object.keys(body).some(key => !['revision', 'voices', 'activeVoice'].includes(key)) ||
    typeof body.revision !== 'string' ||
    typeof body.activeVoice !== 'string'
  )
    throw new Error('无效的音色设置');
  const voices = voiceLibrary(body.voices);

  if (body.activeVoice && !voices.some(voice => voice.id === body.activeVoice)) throw new Error('音色不存在');
  const store = getAdminStore();
  const snapshot = await store.read();

  if (snapshot.revision !== body.revision) throw new Error('配置已变化');
  const source = JSON.parse(snapshot.source);
  const app = source['alemonjs-agent-link'];

  app.media = { ...app.media, voices: body.voices, activeVoice: body.activeVoice };
  await store.save(JSON.stringify(source), body.revision);
  let message = '音色设置已保存';

  try {
    getConfig().reload();
  } catch {
    message = '已保存，请重启后核对运行状态';
  }

  return { data: await readVoiceSettings(), message };
};

export const probeVoices = async (id?: unknown) => {
  const config = getMediaConfig();

  if (id !== undefined && (typeof id !== 'string' || !config.voices?.some(voice => voice.id === id))) throw new Error('音色不存在');
  for (const voice of (config.voices || []).filter(voice => id === undefined || voice.id === id)) {
    let status = '未配置免费测活地址';
    let httpStatus: number | undefined;

    if (voice.probeUrl) {
      try {
        // No credentials are sent to custom diagnostic addresses.
        const response = await fetch(voice.probeUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });

        httpStatus = response.status;
        status = response.ok ? '可连通（不代表可合成）' : '测活未通过';
        await response.body?.cancel();
      } catch {
        status = '测活失败';
      }
    }
    if (probes.size >= 1000) probes.clear();
    probes.set(probeKey(voice), { checkedAt: Date.now(), status, httpStatus });
  }

  return voiceSnapshot();
};
