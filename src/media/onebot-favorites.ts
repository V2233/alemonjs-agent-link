import { ResultCode, useClient } from 'alemonjs';

type FavoriteEvent = { Platform?: string };
type FavoriteClient = {
  agentLink: {
    stickerFavorites(args: { count: number }): Promise<unknown>;
    stickerFavoriteAdd(args: { data: string; name?: string }): Promise<unknown>;
    stickerFavoriteRename(args: { emojiId: string; name: string }): Promise<unknown>;
    stickerFavoriteDelete(args: { emojiId: string }): Promise<unknown>;
  };
};
type FavoriteResult = { code: number; data?: { urls?: unknown; emojiId?: unknown } };
const clientOf = (event: FavoriteEvent): FavoriteClient | undefined => {
  if (event.Platform !== 'onebot') return undefined;
  try {
    return useClient<FavoriteClient>(event as never)[0];
  } catch {
    return undefined;
  }
};
const firstResult = async (run: () => Promise<unknown>): Promise<FavoriteResult | undefined> => {
  try {
    const result = (await run()) as FavoriteResult[];

    return Array.isArray(result) && result.length === 1 && result[0].code === ResultCode.Ok ? result[0] : undefined;
  } catch {
    return undefined;
  }
};

/** Read the bot account's QQ favorite stickers through the OneBot extension action, if available. */
export const fetchOnebotFavoriteStickers = async (event: FavoriteEvent, count: number): Promise<string[] | undefined> => {
  if (event.Platform !== 'onebot' || !Number.isSafeInteger(count) || count < 1 || count > 500) return undefined;
  const client = clientOf(event);

  if (!client) return undefined;
  const result = await firstResult(() => client.agentLink.stickerFavorites({ count }));

  if (!result) return undefined;
  const urls = result.data?.urls;

  return Array.isArray(urls)
    ? urls.filter((url): url is string => typeof url === 'string' && url.length <= 2048 && /^https:\/\//u.test(url) && !/[\0\r\n]/u.test(url))
    : [];
};

/** Add one local image to the bot account's QQ favorite stickers and return the platform emoji id. */
export const addOnebotFavoriteSticker = async (event: FavoriteEvent, data: Buffer, name?: string): Promise<string | undefined> => {
  if (event.Platform !== 'onebot' || data.length === 0 || data.length > 5 * 1024 * 1024) return undefined;
  const normalized = typeof name === 'string' ? name.trim().slice(0, 20) : '';
  const client = clientOf(event);

  if (!client) return undefined;
  const result = await firstResult(() => client.agentLink.stickerFavoriteAdd({ data: data.toString('base64'), ...(normalized ? { name: normalized } : {}) }));
  const emojiId = result?.data?.emojiId;

  return typeof emojiId === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(emojiId) ? emojiId : undefined;
};

export const renameOnebotFavoriteSticker = async (event: FavoriteEvent, emojiId: string, name: string): Promise<boolean> => {
  const normalized = typeof name === 'string' ? name.trim().slice(0, 20) : '';

  if (event.Platform !== 'onebot' || !/^[A-Za-z0-9_-]{1,64}$/u.test(emojiId) || !normalized) return false;
  const client = clientOf(event);

  return client ? Boolean(await firstResult(() => client.agentLink.stickerFavoriteRename({ emojiId, name: normalized }))) : false;
};

export const deleteOnebotFavoriteSticker = async (event: FavoriteEvent, emojiId: string): Promise<boolean> => {
  if (event.Platform !== 'onebot' || !/^[A-Za-z0-9_-]{1,64}$/u.test(emojiId)) return false;
  const client = clientOf(event);

  return client ? Boolean(await firstResult(() => client.agentLink.stickerFavoriteDelete({ emojiId }))) : false;
};
