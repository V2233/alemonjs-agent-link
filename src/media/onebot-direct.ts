import type { OneBotConnection } from '../onebot/connection';

const EMOJI_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const normalizeUrls = (rows: unknown[]): string[] =>
  rows
    .map(row => {
      if (typeof row === 'string') return row;
      if (row && typeof row === 'object' && 'url' in row && typeof row.url === 'string') return row.url;

      return '';
    })
    .filter(url => url.length > 0 && url.length <= 2048 && /^https:\/\//u.test(url) && !/[\0\r\n]/u.test(url));
const emojiIdOf = (result: unknown): string | undefined => {
  if (typeof result === 'string') return EMOJI_ID.test(result) ? result : undefined;
  if (!result || typeof result !== 'object') return undefined;
  const row = result as Record<string, unknown>;
  const nested = row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : undefined;
  const value = [row.emoji_id, row.emojiId, row.id, nested?.emoji_id, nested?.emojiId, nested?.id].find(
    item => typeof item === 'string' || typeof item === 'number'
  );

  return typeof value === 'string' || typeof value === 'number' ? (EMOJI_ID.test(String(value)) ? String(value) : undefined) : undefined;
};

/** Panel-only helpers: they read the live OneBot connection without a chat event. */
export const fetchFavoriteUrlsDirect = async (connection: OneBotConnection, count: number): Promise<string[] | undefined> => {
  if (!Number.isSafeInteger(count) || count < 1 || count > 500) return undefined;
  try {
    const result: unknown = await connection.call('fetch_custom_face', { count });
    const rows: unknown[] = Array.isArray(result)
      ? result
      : result && typeof result === 'object' && 'data' in result && Array.isArray(result.data)
        ? result.data
        : [];

    return normalizeUrls(rows);
  } catch {
    return undefined;
  }
};

export const addFavoriteDirect = async (connection: OneBotConnection, data: Buffer, name?: string): Promise<string | undefined> => {
  if (!data.length || data.length > 5 * 1024 * 1024) return undefined;
  try {
    const normalized = typeof name === 'string' ? name.trim().slice(0, 20) : '';
    const result: unknown = await connection.call('add_custom_face', {
      file: `base64://${data.toString('base64')}`,
      ...(normalized ? { name: normalized } : {})
    });

    return emojiIdOf(result);
  } catch {
    return undefined;
  }
};

export const renameFavoriteDirect = async (connection: OneBotConnection, emojiId: string, name: string): Promise<boolean> => {
  const normalized = typeof name === 'string' ? name.trim().slice(0, 20) : '';

  if (!EMOJI_ID.test(emojiId) || !normalized) return false;
  try {
    await connection.call('modify_custom_face', { emoji_id: emojiId, desc: normalized });

    return true;
  } catch {
    return false;
  }
};

export const deleteFavoriteDirect = async (connection: OneBotConnection, emojiId: string): Promise<boolean> => {
  if (!EMOJI_ID.test(emojiId)) return false;
  try {
    await connection.call('delete_custom_face', { emoji_id: emojiId });

    return true;
  } catch {
    return false;
  }
};
