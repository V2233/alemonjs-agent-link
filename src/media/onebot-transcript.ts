import { ResultCode, useClient, type MessageMediaItem } from 'alemonjs';
import { getMediaConfig } from './config';

type VoiceEvent = {
  Platform?: string;
  BotId?: string;
  MessageId?: string;
  UserId?: string;
  ChannelId?: string;
  IsPrivate?: boolean;
  MessageMedia?: MessageMediaItem[];
};

// QQ's extension uses the message ID, so never assign one transcript to multiple recordings.
export const currentVoiceTranscript = async (event: VoiceEvent): Promise<MessageMediaItem[] | undefined> => {
  const media = event.MessageMedia;
  const audio = media?.filter(item => item.Type === 'audio') || [];

  if (event.Platform !== 'onebot' || !event.MessageId || audio.length !== 1 || audio[0].Transcript?.trim()) return media;
  try {
    const [client] = useClient<{ agentLink: { transcribeCurrentVoice(): Promise<unknown>; convertCurrentVoice(): Promise<unknown> } }>(event as never);

    try {
      const result = (await client.agentLink.transcribeCurrentVoice()) as { code: number; data?: { text?: unknown } }[];
      const text = result?.length === 1 && result[0].code === ResultCode.Ok ? result[0].data?.text : undefined;

      if (typeof text === 'string' && text.trim() && text.length <= 12000)
        return media?.map(item => (item === audio[0] ? { ...item, Transcript: text.trim() } : item));
    } catch {
      /* Try the configured ASR using the converted recording. */
    }
    if (!getMediaConfig().asr || !(audio[0] as MessageMediaItem & { _onebotRecordFile?: string })._onebotRecordFile) return media;
    const result = (await client.agentLink.convertCurrentVoice()) as { code: number; data?: { base64?: unknown; url?: unknown } }[];
    const converted = result?.length === 1 && result[0].code === ResultCode.Ok ? result[0].data : undefined;

    if (typeof converted?.base64 === 'string') return media?.map(item => (item === audio[0] ? { ...item, _onebotWav: converted.base64 } : item));
    const url = converted?.url;

    if (typeof url === 'string') return media?.map(item => (item === audio[0] ? { ...item, AudioUrl: url } : item));

    return media;
  } catch {
    return media;
  }
};
