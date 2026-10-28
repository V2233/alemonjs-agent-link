import { ResultCode, useClient, type MessageMediaItem } from 'alemonjs';
import { getMediaConfig } from './config';

type ImageEvent = { Platform?: string; MessageId?: string; MessageMedia?: MessageMediaItem[] };

export const bindOnebotImageResolver = (event: ImageEvent): ((index: number) => Promise<{ base64?: string; url?: string } | undefined>) | undefined => {
  if (event.Platform !== 'onebot' || !event.MessageId) return;
  try {
    const [client] = useClient<{ agentLink: { resolveCurrentImage(args: { index: number }): Promise<unknown> } }>(event as never);

    return async index => {
      try {
        const result = (await client.agentLink.resolveCurrentImage({ index })) as { code: number; data?: { base64?: unknown; url?: unknown } }[];
        const value = result?.length === 1 && result[0].code === ResultCode.Ok ? result[0].data : undefined;

        if (typeof value?.base64 === 'string') return { base64: value.base64 };
        if (typeof value?.url === 'string') return { url: value.url };
      } catch {
        /* The caller will retain the original media failure. */
      }

      return undefined;
    };
  } catch {
    return undefined;
  }
};

export const resolveCurrentImages = async (event: ImageEvent): Promise<MessageMediaItem[] | undefined> => {
  const media = event.MessageMedia;

  if (event.Platform !== 'onebot' || !event.MessageId || !media?.length) return media;
  if (
    !media.some(
      item =>
        ['image', 'sticker', 'animation'].includes(item.Type) &&
        !(item as MessageMediaItem & { _onebotQuoted?: boolean })._onebotQuoted &&
        (item as MessageMediaItem & { _onebotImageFile?: string })._onebotImageFile
    )
  )
    return media;
  try {
    if (media.length > getMediaConfig().maxAttachments) return media;
    const lookup = bindOnebotImageResolver(event);

    if (!lookup) return media;

    return await Promise.all(
      media.map(async (item, index) => {
        const file = (item as MessageMediaItem & { _onebotImageFile?: string })._onebotImageFile;

        if (!['image', 'sticker', 'animation'].includes(item.Type) || !file || (item as MessageMediaItem & { _onebotQuoted?: boolean })._onebotQuoted)
          return item;
        const resolve = async () => {
          try {
            const value = await lookup(index);

            if (typeof value?.base64 === 'string') return { ...item, _onebotImage: value.base64 };
            if (typeof value?.url === 'string') return { ...item, Url: value.url };
          } catch {
            /* Retain the original item so the normal media error is shown. */
          }

          return item;
        };

        return item.Url ? { ...item, _onebotImageFallback: resolve } : await resolve();
      })
    );
  } catch {
    return media;
  }
};
